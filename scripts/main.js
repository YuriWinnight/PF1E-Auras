/*
 * PF1e Auras v0.1.8
 * Foundry VTT 11.315 / PF1e first playable version, added GM socket tick requests and more robust player-owned party detection.
 *
 * Основная идея:
 * - Настройки ауры хранятся на Item через flags[pf1e-auras].aura.
 * - Команды/роли хранятся на TokenDocument через flags[pf1e-auras].team.
 * - Ядро работает только на активном ГМе.
 * - Игроки просто включают активность эффекта, а ГМ-клиент раздаёт копии.
 */

const PPA = {
  ID: "pf1e-auras",
  LEGACY_IDS: ["PF1e-Auras", "pod-pyvo-auras"],
  FLAG_AURA: "aura",
  FLAG_COPY: "copy",
  FLAG_TEAM: "team",
  intervalId: null,
  running: false,
  visualStore: {
    circles: new Map()
  },
  hoveredTokenIds: new Set()
};

globalThis.PF1eAuras = PPA;
// Совместимость со старыми именами API, чтобы старые макросы/консольные команды не ломались.
globalThis.PodPyvoAuras = PPA;

Hooks.once("init", () => {
  game.settings.register(PPA.ID, "tickMs", {
    name: "Частота проверки аур",
    hint: "Как часто активный ГМ-клиент пересчитывает ауры. 100 мс даёт более плавное движение, 250–500 мс легче для слабых систем.",
    scope: "world",
    config: true,
    type: Number,
    default: 100,
    range: {
      min: 50,
      max: 1000,
      step: 50
    }
  });

  game.settings.register(PPA.ID, "playersCanAssignFriendlyTeam", {
    name: "Игроки могут назначать команду своим токенам",
    hint: "Если включено, игрок-владелец может пользоваться менеджером команд для своих токенов. ГМ всё равно может назначать любые команды.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(PPA.ID, "debug", {
    name: "Debug-лог аур",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
});

Hooks.once("ready", () => {
  registerPublicApi();
  registerSocketListener();
  startIfResponsibleGM();
});

Hooks.on("canvasReady", () => {
  startIfResponsibleGM();
  queueTick();
  window.setTimeout(() => updateHoverOnlyTemplateVisibility(), 100);
});

Hooks.on("hoverToken", (token, hovered) => {
  if (!token?.id) return;

  if (hovered) PPA.hoveredTokenIds.add(token.id);
  else PPA.hoveredTokenIds.delete(token.id);

  updateHoverOnlyTemplateVisibility();
});

Hooks.on("createMeasuredTemplate", () => window.setTimeout(() => updateHoverOnlyTemplateVisibility(), 50));

Hooks.on("updateItem", (item, changed) => {
  const aura = getAuraConfig(item);
  const copy = getAuraCopyConfig(item);

  if (aura?.isAura || copy || changed?.system?.active !== undefined || changed?.flags?.[PPA.ID]) {
    queueTick();
    requestGmTick("updateItem");
  }
});

Hooks.on("updateActor", (actor, changed) => {
  // PF1e иногда обновляет состояние листа через актёра, а не через явный updateItem.
  // Просим активного ГМа пересчитать ауры после такого обновления.
  if (changed?.items || changed?.system || changed?.flags) {
    queueTick();
    requestGmTick("updateActor");
  }
});

Hooks.on("deleteItem", () => { queueTick(); requestGmTick("deleteItem"); });
Hooks.on("updateToken", () => { queueTick(15); requestGmTick("updateToken", 50); });
Hooks.on("refreshToken", () => queueTick(15));
Hooks.on("createToken", () => { queueTick(15); requestGmTick("createToken", 50); });
Hooks.on("deleteToken", () => { queueTick(15); requestGmTick("deleteToken", 50); });
Hooks.on("updateMeasuredTemplate", () => {
  queueTick();
  window.setTimeout(() => updateHoverOnlyTemplateVisibility(), 25);
});
Hooks.on("deleteMeasuredTemplate", templateDocument => {
  queueTick();
  removeAuraVisual(templateDocument?.id);
  window.setTimeout(() => updateHoverOnlyTemplateVisibility(), 25);
});

Hooks.on("renderItemSheet", (app, html) => {
  try {
    const root = html instanceof jQuery ? html : $(html);

    const tryInject = (delay = 0) => {
      window.setTimeout(() => {
        try {
          injectAuraControlsIntoItemSheet(app, html);
        } catch (err) {
          console.error("PF1e Auras: failed to inject item sheet controls", err);
        }
      }, delay);
    };

    tryInject(0);
    tryInject(100);
    tryInject(300);

    root.find('[data-tab], .tabs a, .sheet-tabs a, nav a')
      .off('click.pf1e-auras')
      .on('click.pf1e-auras', () => {
        tryInject(50);
        tryInject(180);
      });
  } catch (err) {
    console.error("PF1e Auras: failed to prepare item sheet controls", err);
  }
});

Hooks.on("getSceneControlButtons", controls => {
  const tokenControls = controls.find(c => c.name === "token");
  if (!tokenControls) return;

  tokenControls.tools.push({
    name: "pod-pyvo-aura-team-manager",
    title: "Команды аур",
    icon: "fas fa-users-cog",
    button: true,
    visible: game.user.isGM || game.settings.get(PPA.ID, "playersCanAssignFriendlyTeam"),
    onClick: () => showTeamManagerDialog()
  });

  tokenControls.tools.push({
    name: "pod-pyvo-aura-cleanup",
    title: "Очистить ауры",
    icon: "fas fa-broom",
    button: true,
    visible: game.user.isGM,
    onClick: () => showCleanupDialog()
  });
});

function registerPublicApi() {
  PPA.start = startEngine;
  PPA.stop = stopEngine;
  PPA.tick = tickAuras;
  PPA.openTeamManager = showTeamManagerDialog;
  PPA.cleanup = cleanupAuraScene;
  PPA.configureItemAura = configureItemAura;
}

function debugLog(...args) {
  if (game.settings.get(PPA.ID, "debug")) console.log("PF1e Auras:", ...args);
}

function registerSocketListener() {
  try {
    game.socket?.on?.(`module.${PPA.ID}`, data => {
      if (!data || data.type !== "requestTick") return;
      if (!isResponsibleGM()) return;

      // Запускаем несколько пересчётов с маленькой задержкой: при клике игрока
      // данные Item/Actor могут прийти ГМу на долю секунды позже socket-сообщения.
      queueTick(Number(data.delay ?? 25));
      queueTick(150);
      queueTick(350);
      debugLog("GM tick requested by socket", data.reason || "unknown");
    });
  } catch (err) {
    console.warn("PF1e Auras: cannot register socket listener", err);
  }
}

function requestGmTick(reason = "unknown", delay = 25) {
  try {
    if (isResponsibleGM()) {
      queueTick(delay);
      return;
    }

    game.socket?.emit?.(`module.${PPA.ID}`, {
      type: "requestTick",
      reason,
      delay,
      userId: game.user?.id || null,
      sceneId: canvas?.scene?.id || null
    });
  } catch (err) {
    console.warn("PF1e Auras: cannot request GM tick", err);
  }
}

function isResponsibleGM() {
  const activeGM = game.users?.activeGM;
  return !!game.user?.isGM && (!activeGM || activeGM.id === game.user.id);
}

function startIfResponsibleGM() {
  if (!isResponsibleGM()) return;
  startEngine();
}

function startEngine() {
  if (!isResponsibleGM()) return;
  if (PPA.intervalId) return;

  const tickMs = Number(game.settings.get(PPA.ID, "tickMs")) || 250;
  PPA.intervalId = setInterval(() => tickAuras(), tickMs);
  debugLog("engine started", tickMs);
  tickAuras();
}

function stopEngine() {
  if (PPA.intervalId) {
    clearInterval(PPA.intervalId);
    PPA.intervalId = null;
  }
  PPA.running = false;
  debugLog("engine stopped");
}

function queueTick(delay = 25) {
  if (!isResponsibleGM()) return;
  window.clearTimeout(PPA.queuedTick);
  PPA.queuedTick = window.setTimeout(() => tickAuras(), delay);
}

function getFlagWithLegacy(document, key) {
  if (!document) return null;

  const readFlag = scope => {
    // В Foundry scope флага должен быть валидным id пакета: нижний регистр и дефисы.
    // Поэтому старый scope PF1e-Auras нельзя читать через getFlag — он вызывает ошибку.
    // Но если такие данные уже записались раньше, их можно безопасно прочитать напрямую из document.flags.
    if (scope === PPA.ID && document.getFlag) {
      try {
        const value = document.getFlag(scope, key);
        if (value !== undefined && value !== null) return value;
      } catch (err) {
        console.warn("PF1e Auras: cannot read current flag scope", scope, err);
      }
    }

    const raw = document.flags?.[scope]?.[key];
    if (raw !== undefined && raw !== null) return raw;

    return null;
  };

  const current = readFlag(PPA.ID);
  if (current !== undefined && current !== null) return current;

  for (const legacyId of PPA.LEGACY_IDS || []) {
    const legacy = readFlag(legacyId);
    if (legacy !== undefined && legacy !== null) return legacy;
  }

  return null;
}

function getAuraConfig(item) {
  return getFlagWithLegacy(item, PPA.FLAG_AURA);
}

function getAuraCopyConfig(item) {
  return getFlagWithLegacy(item, PPA.FLAG_COPY);
}

function getTemplateFlag(templateDocument) {
  if (!templateDocument) return null;

  const readScopeData = scope => {
    const data = templateDocument.flags?.[scope];
    if (data && typeof data === "object" && data.template === true) return data;
    return null;
  };

  const current = readScopeData(PPA.ID);
  if (current) return current;

  for (const legacyId of PPA.LEGACY_IDS || []) {
    const legacy = readScopeData(legacyId);
    if (legacy) return legacy;
  }

  // Старый ошибочный формат мог хранить только boolean template=true.
  // В таком случае возвращаем минимальный объект, чтобы шаблон считался аурным,
  // но без config/sourceTokenId он не будет показываться по hover-only логике.
  const oldBool = getFlagWithLegacy(templateDocument, "template");
  if (oldBool === true) return { template: true };

  return null;
}

function isAuraEnabledItem(item) {
  const cfg = getAuraConfig(item);
  if (!cfg?.isAura) return false;
  if (getAuraCopyConfig(item)) return false;
  return item.system?.active === true;
}

function isProbablyPF1EffectItem(item) {
  if (!item) return false;
  if (item.type === "buff") return true;
  if (item.system && Object.prototype.hasOwnProperty.call(item.system, "active")) return true;
  return false;
}

function injectAuraControlsIntoItemSheet(app, html) {
  const item = app.object;
  if (!isProbablyPF1EffectItem(item)) return;

  const root = html instanceof jQuery ? html : $(html);
  root.find(".pod-pyvo-aura-block").remove();

  const advancedTab = findAdvancedTab(root);

  // Важно: блок ауры добавляется только во вкладку "Продвинутый".
  // Если вкладки Advanced в конкретном листе нет, ничего не вставляем,
  // чтобы кнопки не появлялись на остальных вкладках.
  if (!advancedTab?.length) return;

  const cfg = getAuraConfig(item) || {};
  const isAura = cfg.isAura === true;
  const configured = isAura && cfg.configured === true;

  const hoverText = cfg.showOnHoverOnly ? " · только при наведении" : "";
  const summary = configured
    ? `Радиус: ${Number(cfg.radiusFeet) || 10} футов · ${displayModeLabel(cfg.displayMode)}${hoverText}`
    : "Шаблон ещё не настроен.";

  const block = $(
    `<div class="pod-pyvo-aura-block pod-pyvo-aura-block-advanced">
      <h3><i class="fas fa-bullseye"></i> Командная аура</h3>
      <div class="pod-pyvo-aura-row">
        <label>
          <input type="checkbox" class="pod-pyvo-is-aura" ${isAura ? "checked" : ""}/>
          Является аурой
        </label>
      </div>
      <div class="pod-pyvo-aura-configured" style="display:${configured ? "block" : "none"};">
        <button type="button" class="pod-pyvo-change-template"><i class="fas fa-drafting-compass"></i> Изменить шаблон</button>
        <div class="pod-pyvo-aura-summary">${summary}</div>
      </div>
    </div>`
  );

  block.find(".pod-pyvo-is-aura").on("change", async ev => {
    const checked = ev.currentTarget.checked;

    if (checked) {
      // Если галочку включили заново после отключения, старой настройки уже нет,
      // поэтому окно настройки шаблона снова открывается.
      const result = await showAuraConfigDialog(item, getAuraConfig(item) || {});
      if (!result) {
        ev.currentTarget.checked = false;
        return;
      }

      await item.setFlag(PPA.ID, PPA.FLAG_AURA, result);
      app.render(false);
      queueTick(10);
      requestGmTick("auraConfigured", 50);
    } else {
      // Полностью убираем настройку ауры. После этого кнопка
      // "Изменить шаблон" пропадёт, а повторное включение снова откроет настройку.
      await item.unsetFlag(PPA.ID, PPA.FLAG_AURA);
      app.render(false);
      queueTick(10);
      requestGmTick("auraUnconfigured", 50);
    }
  });

  block.find(".pod-pyvo-change-template").on("click", async () => {
    const fresh = getAuraConfig(item) || {};
    const result = await showAuraConfigDialog(item, fresh);
    if (!result) return;

    await item.setFlag(PPA.ID, PPA.FLAG_AURA, result);
    app.render(false);
    queueTick(10);
  });

  const insertionTarget = findAdvancedInsertionTarget(advancedTab);
  insertionTarget.append(block);
}

function normalizeUiText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function elementLooksLikeAdvancedTab(element) {
  const $el = $(element);
  const tab = normalizeUiText($el.attr("data-tab") || $el.data("tab") || "");
  const label = normalizeUiText($el.text());
  const title = normalizeUiText($el.attr("title") || "");
  const combined = `${tab} ${label} ${title}`;

  return (
    combined.includes("advanced") ||
    combined.includes("продвинут") ||
    combined.includes("дополнительно") ||
    combined.includes("расшир")
  );
}

function findAdvancedTab(root) {
  // Сначала ищем тело вкладки по самым частым data-tab.
  const directBodySelectors = [
    '.tab[data-tab="advanced"]',
    '.tab[data-tab="details-advanced"]',
    '.tab[data-tab="advancedTab"]',
    '.tab[data-tab="advanced-settings"]',
    '.tab[data-tab="misc"]',
    '.tab[data-tab="notes"]',
    '.tab.advanced',
    '.advanced.tab'
  ];

  for (const selector of directBodySelectors) {
    const found = root.find(selector).filter((_, el) => {
      const $el = $(el);
      if ($el.closest('nav, .tabs, .sheet-tabs').length) return false;
      // Если найденная вкладка скрыта и есть активная вкладка, лучше не вставлять туда блок.
      if ($el.hasClass('tab') && !$el.hasClass('active') && root.find('.tab.active').length) return false;
      return true;
    }).first();

    if (found.length) return found;
  }

  const allTabControls = root.find('[data-tab], .tabs a, .sheet-tabs a, nav a').filter((_, el) => {
    const $el = $(el);
    if ($el.hasClass('tab') || $el.closest('.tab').length) return false;
    return elementLooksLikeAdvancedTab(el);
  });

  const activeAdvancedNav = allTabControls.filter((_, el) => {
    const $el = $(el);
    return $el.hasClass('active') || $el.parent().hasClass('active');
  }).first();

  const navToUse = activeAdvancedNav.length ? activeAdvancedNav : allTabControls.first();

  if (navToUse.length) {
    const tabName = navToUse.attr('data-tab') || navToUse.data('tab');

    if (tabName) {
      const escaped = String(tabName).replace(/"/g, '\"');
      const body = root.find(`.tab[data-tab="${escaped}"]`).filter((_, el) => !$(el).closest('nav, .tabs, .sheet-tabs').length).first();
      if (body.length) return body;
    }

    // Если nav «Продвинутый» активен, но тело вкладки в PF1e не имеет совпадающего data-tab,
    // берём активное тело вкладки. Это всё ещё не покажет блок на других вкладках, потому что
    // условие сработает только при активной вкладке «Продвинутый».
    if (activeAdvancedNav.length) {
      const activeBody = root.find('.tab.active').filter((_, el) => !$(el).closest('nav, .tabs, .sheet-tabs').length).last();
      if (activeBody.length) return activeBody;

      const visibleBody = root.find('.tab:visible').filter((_, el) => !$(el).closest('nav, .tabs, .sheet-tabs').length).last();
      if (visibleBody.length) return visibleBody;

      const sheetBody = root.find('.sheet-body, .body, form').first();
      if (sheetBody.length) return sheetBody;
    }
  }

  return null;
}
function findAdvancedInsertionTarget(advancedTab) {
  const candidates = [
    advancedTab.find('.form-group').last().parent(),
    advancedTab.find('fieldset').last(),
    advancedTab.find('.tab-content').first(),
    advancedTab.find('.form-body').first(),
    advancedTab
  ];

  for (const candidate of candidates) {
    if (candidate?.length) return candidate;
  }

  return advancedTab;
}

function displayModeLabel(mode) {
  switch (mode) {
    case "hidden": return "Скрытый";
    case "circle": return "Только контур";
    case "cells": return "Только клетки";
    case "circle-cells": return "Контур + клетки";
    default: return "Контур + клетки";
  }
}

function alphaToPercent(value, fallbackPercent = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallbackPercent;
  if (n <= 1) return Math.round(n * 100);
  return Math.max(0, Math.min(100, Math.round(n)));
}

function percentToAlpha(value, fallbackAlpha = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallbackAlpha;
  return Math.max(0, Math.min(100, n)) / 100;
}

async function configureItemAura(item) {
  const oldCfg = getAuraConfig(item) || {};
  const result = await showAuraConfigDialog(item, oldCfg);
  if (!result) return false;
  await item.setFlag(PPA.ID, PPA.FLAG_AURA, result);
  queueTick();
  return true;
}

function showAuraConfigDialog(item, oldConfig = {}) {
  const defaultRadius = Number(oldConfig.radiusFeet) || 10;
  const defaultDisplayMode = oldConfig.displayMode || "circle-cells";
  const defaultOutlineColor = oldConfig.outlineColor || oldConfig.circleColor || game.user.color || "#00ffff";
  const defaultCellPercent = alphaToPercent(oldConfig.cellAlpha ?? oldConfig.fillAlpha, 35);
  const defaultOutlinePercent = alphaToPercent(oldConfig.outlineAlpha ?? oldConfig.borderAlpha, 85);
  const defaultShowLabel = oldConfig.showLabel === true;
  const defaultShowOnHoverOnly = oldConfig.showOnHoverOnly === true;

  return new Promise(resolve => {
    const dialog = new Dialog({
      title: `Настройка ауры: ${item.name}`,
      resizable: true,
      content: `
        <form class="pod-pyvo-aura-dialog">
          <div class="form-group">
            <label>Радиус в футах</label>
            <input type="number" name="radius" value="${defaultRadius}" min="5" step="5"/>
          </div>
          <div class="form-group">
            <label>Отображение</label>
            <select name="displayMode">
              <option value="hidden" ${defaultDisplayMode === "hidden" ? "selected" : ""}>Скрытый</option>
              <option value="circle" ${defaultDisplayMode === "circle" ? "selected" : ""}>Только контур</option>
              <option value="cells" ${defaultDisplayMode === "cells" ? "selected" : ""}>Только клетки</option>
              <option value="circle-cells" ${defaultDisplayMode === "circle-cells" ? "selected" : ""}>Контур + клетки</option>
            </select>
          </div>
          <div class="pod-pyvo-outline-field">
            <div class="form-group">
              <label>Цвет контура</label>
              <input type="color" name="outlineColor" value="${defaultOutlineColor}"/>
            </div>
            <div class="form-group">
              <label>Прозрачность контура: <span class="outlineAlphaLabel">${defaultOutlinePercent}</span>%</label>
              <div class="pod-pyvo-alpha-row">
                <input type="range" name="outlineAlphaRange" value="${defaultOutlinePercent}" min="0" max="100" step="1"/>
                <input type="number" name="outlineAlphaPercent" value="${defaultOutlinePercent}" min="0" max="100" step="1"/>
              </div>
              <p class="notes">0 — полностью прозрачно. 100 — полностью непрозрачно.</p>
            </div>
          </div>
          <div class="pod-pyvo-cell-field">
            <div class="form-group">
              <label>Прозрачность клеток: <span class="cellAlphaLabel">${defaultCellPercent}</span>%</label>
              <div class="pod-pyvo-alpha-row">
                <input type="range" name="cellAlphaRange" value="${defaultCellPercent}" min="0" max="100" step="1"/>
                <input type="number" name="cellAlphaPercent" value="${defaultCellPercent}" min="0" max="100" step="1"/>
              </div>
              <p class="notes">0 — клетки не видны. 100 — клетки максимально заметны. Цвет берётся из цвета активного ГМа.</p>
            </div>
          </div>
          <div class="form-group pod-pyvo-label-field">
            <label>
              <input type="checkbox" name="showLabel" ${defaultShowLabel ? "checked" : ""}/>
              Показывать подпись Foundry, если она доступна
            </label>
          </div>
          <div class="form-group">
            <label>
              <input type="checkbox" name="showOnHoverOnly" ${defaultShowOnHoverOnly ? "checked" : ""}/>
              Показывать шаблон только при наведении на носителя ауры
            </label>
            <p class="notes">Если включено, шаблон ауры будет виден только тому пользователю, который навёл мышь на токен-носитель. Без наведения шаблон скрыт.</p>
          </div>
          <p class="notes pod-pyvo-aura-hint"></p>
        </form>
      `,
      buttons: {
        r10: { label: "10 футов", callback: html => resolve(readAuraDialog(html, 10)) },
        r20: { label: "20 футов", callback: html => resolve(readAuraDialog(html, 20)) },
        r30: { label: "30 футов", callback: html => resolve(readAuraDialog(html, 30)) },
        r60: { label: "60 футов", callback: html => resolve(readAuraDialog(html, 60)) },
        custom: {
          label: "Своё",
          callback: html => {
            const value = Number(html.find('[name="radius"]').val());
            resolve(readAuraDialog(html, Number.isFinite(value) && value > 0 ? value : defaultRadius));
          }
        }
      },
      default: "custom",
      close: () => resolve(null),
      render: html => {
        const appWindow = html.closest(".app.window-app");
        appWindow.css({ width: "640px", minWidth: "560px", minHeight: "420px", resize: "both", overflow: "auto" });
        appWindow.find(".window-content").css({ overflow: "auto" });

        bindPercentPair(html, "outlineAlphaRange", "outlineAlphaPercent", "outlineAlphaLabel");
        bindPercentPair(html, "cellAlphaRange", "cellAlphaPercent", "cellAlphaLabel");

        const updateVisibility = () => {
          const mode = String(html.find('[name="displayMode"]').val() || "circle-cells");
          html.find(".pod-pyvo-outline-field").toggle(mode === "circle" || mode === "circle-cells");
          html.find(".pod-pyvo-cell-field").toggle(mode === "cells" || mode === "circle-cells");
          html.find(".pod-pyvo-label-field").toggle(mode !== "hidden");

          const hint = mode === "hidden"
            ? "Скрытый режим: ничего не отображается, но расчёт ауры работает."
            : mode === "circle"
              ? "Только контур: клетки скрыты."
              : mode === "cells"
                ? "Только клетки: контур скрыт."
                : "Контур + клетки: полный визуал.";
          html.find(".pod-pyvo-aura-hint").text(hint);
        };

        html.find('[name="displayMode"]').on("change", updateVisibility);
        updateVisibility();
      }
    });

    dialog.render(true);
  });
}

function bindPercentPair(html, rangeName, inputName, labelClass) {
  const range = html.find(`[name="${rangeName}"]`);
  const input = html.find(`[name="${inputName}"]`);
  const label = html.find(`.${labelClass}`);

  const setValue = value => {
    const n = Number(value);
    const clamped = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 100;
    range.val(clamped);
    input.val(clamped);
    label.text(clamped);
  };

  range.on("input change", () => setValue(range.val()));
  input.on("input change", () => setValue(input.val()));
  setValue(input.val());
}

function readAuraDialog(html, radiusFeet) {
  const displayMode = String(html.find('[name="displayMode"]').val() || "circle-cells");
  const outlineColor = String(html.find('[name="outlineColor"]').val() || game.user.color || "#00ffff");
  let outlineAlpha = percentToAlpha(html.find('[name="outlineAlphaPercent"]').val(), 0.85);
  let cellAlpha = percentToAlpha(html.find('[name="cellAlphaPercent"]').val(), 0.35);

  let showCells = false;
  let showCircle = false;
  let showLabel = html.find('[name="showLabel"]')[0]?.checked === true;
  const showOnHoverOnly = html.find('[name="showOnHoverOnly"]')[0]?.checked === true;

  if (displayMode === "hidden") {
    showCells = false;
    showCircle = false;
    showLabel = false;
    cellAlpha = 0;
    outlineAlpha = 0;
  } else if (displayMode === "circle") {
    showCells = false;
    showCircle = true;
    cellAlpha = 0;
  } else if (displayMode === "cells") {
    showCells = true;
    showCircle = false;
    outlineAlpha = 0;
  } else {
    showCells = true;
    showCircle = true;
  }

  return {
    isAura: true,
    configured: true,
    radiusFeet,
    displayMode,
    showCells,
    showCircle,
    showLabel,
    showOnHoverOnly,
    outlineColor,
    outlineAlpha,
    cellAlpha,
    templateId: null,
    sceneId: canvas.scene?.id || null
  };
}

function getTokenTeamData(token) {
  return getFlagWithLegacy(token?.document, PPA.FLAG_TEAM) || {};
}

function getExplicitTeamId(token) {
  return getTokenTeamData(token).teamId || null;
}

function isFriendlyToken(token) {
  return token?.document?.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY;
}

function isPlayerOwnedToken(token) {
  if (!token?.actor) return false;

  // В PF1e персонажи игроков не всегда имеют Friendly disposition на сцене.
  // Поэтому для режима "партии" считаем токен дружественным также тогда,
  // когда у его актёра есть владелец-игрок.
  if (token.actor.hasPlayerOwner === true) return true;

  const ownerLevel = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;

  try {
    const users = Array.from(game.users || []).filter(user => user && !user.isGM);

    if (users.some(user => token.actor.testUserPermission?.(user, "OWNER") === true)) {
      return true;
    }

    const ownership = token.actor.ownership || token.actor.data?.permission || {};
    return users.some(user => Number(ownership[user.id] ?? 0) >= ownerLevel);
  } catch (_) {
    return false;
  }
}

function isAutoPartyToken(token) {
  return isFriendlyToken(token) || isPlayerOwnedToken(token);
}

function getEffectiveTeamId(token) {
  const explicit = getExplicitTeamId(token);
  if (explicit) return explicit;

  // Авто-команда для игроков и дружественных токенов.
  // Это нужно, чтобы игроку не приходилось вручную назначать команду своему персонажу.
  if (isAutoPartyToken(token)) return "party";

  return null;
}

function getEffectiveRole(token) {
  const role = getTokenTeamData(token).role || "auto";
  return role;
}

function isTargetReceiver(token) {
  const role = getEffectiveRole(token);
  if (role === "receiver" || role === "source-receiver") return true;
  if (role === "source" || role === "none") return false;

  // Авто-роль получателя для партии: дружественный токен или актёр игрока.
  return isAutoPartyToken(token);
}

function canAuraAffectTarget(sourceToken, targetToken) {
  if (!sourceToken || !targetToken) return false;
  if (sourceToken.id === targetToken.id) return false;

  const sourceTeam = getEffectiveTeamId(sourceToken);
  const targetTeam = getEffectiveTeamId(targetToken);

  if (!sourceTeam || !targetTeam) return false;
  if (sourceTeam !== targetTeam) return false;
  if (!isTargetReceiver(targetToken)) return false;

  return true;
}

function showTeamManagerDialog() {
  const selected = canvas.tokens?.controlled || [];
  if (!selected.length) {
    ui.notifications.warn("Выдели хотя бы один токен.");
    return;
  }

  const canManageAll = game.user.isGM;
  const canPlayersManage = game.settings.get(PPA.ID, "playersCanAssignFriendlyTeam");

  const manageable = selected.filter(t => {
    if (canManageAll) return true;
    if (!canPlayersManage) return false;
    return t.actor?.testUserPermission?.(game.user, "OWNER");
  });

  if (!manageable.length) {
    ui.notifications.warn("Нет токенов, которыми ты можешь управлять.");
    return;
  }

  new Dialog({
    title: "Команды аур",
    content: `
      <form>
        <div class="form-group">
          <label>Команда</label>
          <select name="teamPreset">
            <option value="party">Партия / дружественные</option>
            <option value="enemy_1">Враги 1</option>
            <option value="enemy_2">Враги 2</option>
            <option value="summons">Призванные</option>
            <option value="custom">Своя...</option>
          </select>
        </div>
        <div class="form-group pod-pyvo-custom-team" style="display:none;">
          <label>Своя команда</label>
          <input type="text" name="customTeam" value="custom_team"/>
        </div>
        <div class="form-group">
          <label>Роль</label>
          <select name="role">
            <option value="auto">Авто: по дружественности</option>
            <option value="receiver">Получатель</option>
            <option value="source">Источник</option>
            <option value="source-receiver">Источник + получатель</option>
            <option value="none">Отключить от аур</option>
          </select>
        </div>
        <p class="notes">Выделено: ${selected.length}. Доступно для изменения: ${manageable.length}.<br><b>Авто</b> — токен без ручной роли: дружественные существа получают ауры партии. <b>Отключить от аур</b> — токен не получает командные ауры, даже если стоит в зоне.</p>
      </form>
    `,
    buttons: {
      apply: {
        label: "Применить",
        callback: async html => {
          let teamId = String(html.find('[name="teamPreset"]').val() || "party");
          if (teamId === "custom") teamId = normalizeTeamId(html.find('[name="customTeam"]').val());
          const role = String(html.find('[name="role"]').val() || "auto");

          for (const token of manageable) {
            await token.document.setFlag(PPA.ID, PPA.FLAG_TEAM, {
              teamId,
              teamName: teamLabel(teamId),
              role
            });
          }

          ui.notifications.info(`Команда ауры назначена: ${manageable.length} токен(ов).`);
          queueTick();
        }
      },
      clear: {
        label: "Очистить",
        callback: async () => {
          for (const token of manageable) {
            await token.document.unsetFlag(PPA.ID, PPA.FLAG_TEAM);
          }
          ui.notifications.info(`Команды аур очищены: ${manageable.length} токен(ов).`);
          queueTick();
        }
      },
      cancel: { label: "Отмена" }
    },
    render: html => {
      html.find('[name="teamPreset"]').on("change", ev => {
        html.find(".pod-pyvo-custom-team").toggle(ev.currentTarget.value === "custom");
      });
    },
    default: "apply"
  }).render(true);
}

function normalizeTeamId(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-zа-яё0-9_-]/gi, "");
  return normalized || "custom_team";
}

function teamLabel(teamId) {
  switch (teamId) {
    case "party": return "Партия";
    case "enemy_1": return "Враги 1";
    case "enemy_2": return "Враги 2";
    case "summons": return "Призванные";
    default: return teamId;
  }
}

function showCleanupDialog() {
  new Dialog({
    title: "Очистка командных аур",
    content: `<p>Очистить зависшие шаблоны и копии аур на текущей сцене?</p>`,
    buttons: {
      cleanup: {
        label: "Очистить",
        callback: async () => cleanupAuraScene()
      },
      cancel: { label: "Отмена" }
    },
    default: "cleanup"
  }).render(true);
}

async function cleanupAuraScene() {
  if (!isResponsibleGM()) {
    ui.notifications.warn("Очистку должен выполнить активный ГМ.");
    return;
  }

  const auraTemplates = canvas.templates.placeables.filter(t => getTemplateFlag(t.document));
  if (auraTemplates.length) {
    await safeDeleteMeasuredTemplates(auraTemplates.map(t => t.id));
  }

  for (const token of canvas.tokens.placeables) {
    if (!token.actor) continue;
    const copies = token.actor.items.filter(i => getAuraCopyConfig(i));
    await deleteCopiedAuraItems(token.actor, copies);
  }

  for (const entry of PPA.visualStore.circles.values()) {
    entry.graphic?.destroy?.({ children: true });
  }
  PPA.visualStore.circles.clear();

  ui.notifications.info("Командные ауры очищены на текущей сцене.");
}

async function tickAuras() {
  if (!isResponsibleGM()) return;
  if (!canvas?.scene || !canvas?.tokens) return;
  if (PPA.running) return;

  PPA.running = true;

  try {
    const activeAuras = [];
    const tokens = canvas.tokens.placeables.filter(t => t?.actor);

    for (const sourceToken of tokens) {
      for (const sourceItem of sourceToken.actor.items) {
        if (!isAuraEnabledItem(sourceItem)) {
          const cfg = getAuraConfig(sourceItem);
          if (cfg?.templateId && cfg.sceneId === canvas.scene.id) {
            await deleteAuraTemplateById(cfg.templateId);
            await sourceItem.setFlag(PPA.ID, PPA.FLAG_AURA, { ...cfg, templateId: null });
          }
          continue;
        }

        const cfg = getAuraConfig(sourceItem);
        const templateObject = await ensureAuraTemplate(sourceToken, sourceItem, cfg);
        const auraCellRects = getAuraCellRectsFromTemplate(templateObject);
        applyTemplateVisualMode(templateObject, cfg);

        activeAuras.push({ sourceToken, sourceItem, cfg, templateObject, auraCellRects });
      }
    }

    await cleanupOrphanAuraTemplates(activeAuras);
    await updateAuraCopies(tokens, activeAuras);
  } catch (err) {
    console.error("PF1e Auras: aura tick failed", err);
  } finally {
    PPA.running = false;
  }
}

async function updateAuraCopies(tokens, activeAuras) {
  const actorTokens = [];
  const seen = new Set();
  for (const token of tokens) {
    if (!token.actor) continue;
    if (seen.has(token.actor.id)) continue;
    seen.add(token.actor.id);
    actorTokens.push(token);
  }

  for (const targetToken of actorTokens) {
    const actor = targetToken.actor;
    const validAuras = [];

    for (const aura of activeAuras) {
      if (!canAuraAffectTarget(aura.sourceToken, targetToken)) continue;
      if (!tokenTouchesAuraCellRects(aura.auraCellRects, targetToken)) continue;
      validAuras.push(aura);
    }

    const validKeys = new Set(validAuras.map(a => `${canvas.scene.id}:${a.sourceToken.id}:${a.sourceItem.id}`));
    const copies = actor.items.filter(i => getAuraCopyConfig(i));
    const toDelete = copies.filter(i => {
      const c = getAuraCopyConfig(i);
      const key = `${c.sceneId}:${c.sourceTokenId}:${c.sourceItemId}`;
      return !validKeys.has(key);
    });

    await deleteCopiedAuraItems(actor, toDelete);

    for (const aura of validAuras) {
      const key = `${canvas.scene.id}:${aura.sourceToken.id}:${aura.sourceItem.id}`;
      let existing = actor.items.find(i => {
        const c = getAuraCopyConfig(i);
        return c && `${c.sceneId}:${c.sourceTokenId}:${c.sourceItemId}` === key;
      });

      if (!existing) {
        let itemData = aura.sourceItem.toObject();
        delete itemData._id;
        itemData = stripAuraSourceDataFromCopy(itemData);
        itemData.flags = itemData.flags || {};
        itemData.flags[PPA.ID] = itemData.flags[PPA.ID] || {};
        itemData.flags[PPA.ID][PPA.FLAG_COPY] = {
          sceneId: canvas.scene.id,
          sourceTokenId: aura.sourceToken.id,
          sourceActorId: aura.sourceToken.actor.id,
          sourceItemId: aura.sourceItem.id,
          sourceItemName: aura.sourceItem.name,
          teamId: getEffectiveTeamId(aura.sourceToken)
        };
        itemData.name = `${aura.sourceItem.name}`;
        setProperty(itemData, "system.active", true);

        const created = await actor.createEmbeddedDocuments("Item", [itemData]);
        existing = created[0];
        debugLog("Aura copied", aura.sourceItem.name, "to", targetToken.name);
      } else if (existing.system?.active !== true) {
        await existing.update({ "system.active": true });
      }
    }
  }
}

function stripAuraSourceDataFromCopy(itemData) {
  if (itemData.flags?.[PPA.ID]) {
    delete itemData.flags[PPA.ID][PPA.FLAG_AURA];
  }

  if (itemData.system) {
    if ("scriptCalls" in itemData.system) itemData.system.scriptCalls = [];
    if ("scripts" in itemData.system) itemData.system.scripts = [];
  }
  if ("scriptCalls" in itemData) itemData.scriptCalls = [];
  if ("scripts" in itemData) itemData.scripts = [];

  return itemData;
}

async function deleteCopiedAuraItems(actor, items) {
  if (!actor || !items?.length) return;
  const ids = [...new Set(items.map(i => i?.id).filter(Boolean))];

  for (const id of ids) {
    try {
      if (!actor.items.get(id)) continue;
      await actor.deleteEmbeddedDocuments("Item", [id]);
      await sleep(10);
    } catch (err) {
      const msg = String(err?.message || err || "");
      if (msg.includes("does not exist")) continue;
      console.warn("PF1e Auras: cannot delete aura copy", id, err);
    }
  }
}

function getTemplateConfigSnapshot(cfg = {}) {
  return {
    radiusFeet: Number(cfg.radiusFeet) || 10,
    displayMode: cfg.displayMode || "circle-cells",
    showCells: cfg.showCells === true,
    showCircle: cfg.showCircle === true,
    showLabel: cfg.showLabel === true,
    showOnHoverOnly: cfg.showOnHoverOnly === true,
    outlineColor: cfg.outlineColor || cfg.circleColor || game.user?.color || "#00ffff",
    outlineAlpha: Math.max(0, Math.min(1, Number(cfg.outlineAlpha ?? cfg.borderAlpha ?? 0.85))),
    cellAlpha: Math.max(0, Math.min(1, Number(cfg.cellAlpha ?? cfg.fillAlpha ?? 0.35)))
  };
}

function getTemplateVisualConfig(templateObject) {
  const flag = getTemplateFlag(templateObject?.document);
  return flag?.config || null;
}

function isAuraTemplateHoverVisible(templateObject, cfg = null) {
  const flag = getTemplateFlag(templateObject?.document);
  const visualCfg = cfg || flag?.config || {};

  if (visualCfg.showOnHoverOnly !== true) return true;

  const sourceTokenId = flag?.sourceTokenId;
  if (!sourceTokenId) return false;

  return PPA.hoveredTokenIds.has(sourceTokenId);
}

function updateHoverOnlyTemplateVisibility() {
  if (!canvas?.templates?.placeables) return;

  for (const templateObject of canvas.templates.placeables) {
    const flag = getTemplateFlag(templateObject.document);
    if (!flag?.template) continue;

    const cfg = getTemplateVisualConfig(templateObject);
    if (!cfg) continue;

    try {
      applyTemplateVisualMode(templateObject, cfg);
    } catch (err) {
      console.warn("PF1e Auras: cannot update hover-only aura template visibility", err);
    }
  }
}

async function ensureAuraTemplate(sourceToken, sourceItem, cfg) {
  let templateId = cfg.templateId || null;
  let templateObject = templateId ? canvas.templates.placeables.find(t => t.id === templateId) : null;
  const radiusFeet = Number(cfg.radiusFeet) || 10;

  if (templateId && !templateObject) {
    await sourceItem.setFlag(PPA.ID, PPA.FLAG_AURA, { ...cfg, templateId: null });
    templateId = null;
  }

  if (!templateObject) {
    const created = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [{
      t: "circle",
      user: game.user.id,
      x: sourceToken.center.x,
      y: sourceToken.center.y,
      distance: radiusFeet,
      direction: 0,
      fillColor: game.user.color || "#00ffff",
      hidden: false,
      flags: {
        [PPA.ID]: {
          template: true,
          sourceTokenId: sourceToken.id,
          sourceActorId: sourceToken.actor.id,
          sourceItemId: sourceItem.id,
          config: getTemplateConfigSnapshot(cfg)
        }
      }
    }]);

    templateId = created[0].id;
    await sourceItem.setFlag(PPA.ID, PPA.FLAG_AURA, {
      ...cfg,
      templateId,
      sceneId: canvas.scene.id
    });
    templateObject = await waitForCanvasTemplate(templateId, 80);
  }

  if (!templateObject) return null;

  const updates = {};
  if (!nearlySame(templateObject.document.x, sourceToken.center.x)) updates.x = sourceToken.center.x;
  if (!nearlySame(templateObject.document.y, sourceToken.center.y)) updates.y = sourceToken.center.y;
  if (Number(templateObject.document.distance) !== radiusFeet) updates.distance = radiusFeet;
  if (templateObject.document.hidden !== false) updates.hidden = false;
  if (templateObject.document.fillColor !== (game.user.color || "#00ffff")) updates.fillColor = game.user.color || "#00ffff";
  updates[`flags.${PPA.ID}.config`] = getTemplateConfigSnapshot(cfg);
  updates[`flags.${PPA.ID}.sourceTokenId`] = sourceToken.id;
  updates[`flags.${PPA.ID}.sourceActorId`] = sourceToken.actor.id;
  updates[`flags.${PPA.ID}.sourceItemId`] = sourceItem.id;
  updates[`flags.${PPA.ID}.template`] = true;

  if (Object.keys(updates).length) {
    await templateObject.document.update(updates);
    templateObject = await waitForCanvasTemplate(templateId, 40) || templateObject;
  }

  templateObject.refresh?.();
  return templateObject;
}

async function cleanupOrphanAuraTemplates(activeAuras) {
  const validTemplateIds = new Set(activeAuras.map(a => a.templateObject?.id).filter(Boolean));
  const orphanTemplates = canvas.templates.placeables.filter(t => {
    if (!getTemplateFlag(t.document)) return false;
    return !validTemplateIds.has(t.id);
  });

  if (orphanTemplates.length) {
    await safeDeleteMeasuredTemplates(orphanTemplates.map(t => t.id));
  }

  for (const templateId of [...PPA.visualStore.circles.keys()]) {
    if (!validTemplateIds.has(templateId)) removeAuraVisual(templateId);
  }
}

async function safeDeleteMeasuredTemplates(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  const existing = unique.filter(id => canvas.scene?.templates?.get?.(id) || canvas.templates.placeables.some(t => t.id === id));
  for (const id of unique.filter(id => !existing.includes(id))) removeAuraVisual(id);
  if (!existing.length) return;

  try {
    await canvas.scene.deleteEmbeddedDocuments("MeasuredTemplate", existing);
  } catch (err) {
    for (const id of existing) {
      try {
        if (canvas.scene?.templates?.get?.(id) || canvas.templates.placeables.some(t => t.id === id)) {
          await canvas.scene.deleteEmbeddedDocuments("MeasuredTemplate", [id]);
        }
      } catch (singleErr) {
        const msg = String(singleErr?.message || singleErr || "");
        if (!msg.includes("does not exist")) console.warn("PF1e Auras: cannot delete template", id, singleErr);
      }
    }
  }

  for (const id of existing) removeAuraVisual(id);
}

async function deleteAuraTemplateById(templateId) {
  removeAuraVisual(templateId);
  await safeDeleteMeasuredTemplates([templateId]);
}

function getAuraVisualStore() {
  return PPA.visualStore;
}

function hexToNumber(hex) {
  const clean = String(hex || "#00ffff").replace("#", "");
  const num = Number.parseInt(clean, 16);
  return Number.isFinite(num) ? num : 0x00ffff;
}

function getAuraLayerContainer() {
  return canvas.templates || canvas.stage;
}

function removeAuraVisual(templateId) {
  if (!templateId) return;
  const store = getAuraVisualStore();
  const entry = store.circles.get(templateId);
  if (entry?.graphic) entry.graphic.destroy({ children: true });
  store.circles.delete(templateId);
}

function updateAuraVisualCircle(templateObject, cfg) {
  if (!templateObject) return;
  const showCircle = cfg.showCircle === true || cfg.displayMode === "circle" || cfg.displayMode === "circle-cells";
  const templateId = templateObject.id;

  if (!showCircle) {
    removeAuraVisual(templateId);
    return;
  }

  const store = getAuraVisualStore();
  let entry = store.circles.get(templateId);

  if (!entry || !entry.graphic || entry.graphic.destroyed) {
    const graphic = new PIXI.Graphics();
    graphic.zIndex = 1000000;
    getAuraLayerContainer().addChild(graphic);
    entry = { graphic, x: Number(templateObject.document.x), y: Number(templateObject.document.y) };
    store.circles.set(templateId, entry);
  }

  const targetX = Number(templateObject.document.x);
  const targetY = Number(templateObject.document.y);
  entry.x = Number.isFinite(entry.x) ? entry.x + (targetX - entry.x) * 0.85 : targetX;
  entry.y = Number.isFinite(entry.y) ? entry.y + (targetY - entry.y) * 0.85 : targetY;

  const color = hexToNumber(cfg.outlineColor || game.user.color || "#00ffff");
  const outlineAlpha = Math.max(0, Math.min(1, Number(cfg.outlineAlpha ?? 0.85)));
  const radiusFeet = Number(cfg.radiusFeet) || Number(templateObject.document.distance) || 10;
  const radiusPx = (radiusFeet / (canvas.scene?.grid?.distance || 5)) * canvas.grid.size;

  const g = entry.graphic;
  g.visible = true;
  g.clear();
  if (outlineAlpha > 0) {
    g.lineStyle(3, color, outlineAlpha);
    g.drawCircle(entry.x, entry.y, radiusPx);
  }
}

function applyTemplateVisualMode(templateObject, cfg) {
  if (!templateObject) return;

  const displayMode = cfg.displayMode || "circle-cells";

  if (!isAuraTemplateHoverVisible(templateObject, cfg)) {
    const layer = getHighlightLayer(templateObject);
    forceHideHighlightLayer(layer);

    if (templateObject.template) {
      templateObject.template.visible = false;
      templateObject.template.alpha = 0;
      templateObject.template.renderable = false;
    }
    if (templateObject.controlIcon) {
      templateObject.controlIcon.visible = false;
      templateObject.controlIcon.alpha = 0;
      templateObject.controlIcon.renderable = false;
    }
    if (templateObject.ruler) {
      templateObject.ruler.visible = false;
      templateObject.ruler.alpha = 0;
      templateObject.ruler.renderable = false;
    }

    removeAuraVisual(templateObject.id);
    return;
  }

  const showCells = cfg.showCells === true || displayMode === "cells" || displayMode === "circle-cells";
  const layer = getHighlightLayer(templateObject);

  if (showCells) forceShowHighlightLayer(layer, cfg.cellAlpha ?? 0.35);
  else forceHideHighlightLayer(layer);

  if (templateObject.template) {
    templateObject.template.visible = false;
    templateObject.template.alpha = 0;
    templateObject.template.renderable = false;
  }
  if (templateObject.controlIcon) {
    templateObject.controlIcon.visible = false;
    templateObject.controlIcon.alpha = 0;
    templateObject.controlIcon.renderable = false;
  }
  if (templateObject.ruler) {
    templateObject.ruler.visible = cfg.showLabel === true && displayMode !== "hidden";
    templateObject.ruler.alpha = templateObject.ruler.visible ? 1 : 0;
    templateObject.ruler.renderable = templateObject.ruler.visible;
  }

  updateAuraVisualCircle(templateObject, cfg);
}

function forceHideHighlightLayer(layer, clearGraphics = false) {
  if (!layer) return;
  layer.visible = false;
  layer.alpha = 0;
  layer.renderable = false;

  // В hover-only режиме нельзя очищать GridHighlight полностью: в некоторых версиях
  // Foundry после clear() слой уже не восстанавливается визуально без полного refresh.
  // Для расчётов и повторного показа оставляем positions/графику живыми, просто скрываем слой.
  if (clearGraphics) layer.clear?.();
}

function forceShowHighlightLayer(layer, alpha) {
  if (!layer) return;
  layer.visible = true;
  layer.renderable = true;
  layer.alpha = Math.max(0, Math.min(1, Number(alpha ?? 0.35)));
}

function getHighlightLayer(templateObject) {
  if (!templateObject) return null;
  const layerName = templateObject.highlightId || `MeasuredTemplate.${templateObject.id}`;
  return canvas.grid.getHighlightLayer?.(layerName) || canvas.grid.highlightLayers?.[layerName] || canvas.grid.highlightLayers?.get?.(layerName) || null;
}

function getAuraCellRectsFromTemplate(templateObject) {
  if (!templateObject) return [];
  templateObject.refresh?.();

  let rects = [];
  const layer = getHighlightLayer(templateObject);
  if (layer?.positions) {
    rects = Array.from(layer.positions).map(templatePositionToRect).filter(Boolean);
  }

  if (!rects.length) {
    try {
      rects = templateObject._getGridHighlightPositions().map(templatePositionToRect).filter(Boolean);
    } catch (err) {
      console.warn("PF1e Auras: cannot read template cells", err);
    }
  }

  return rects;
}

function parseTemplatePosition(position) {
  let x = null;
  let y = null;

  if (position && typeof position === "object" && "x" in position && "y" in position) {
    x = Number(position.x);
    y = Number(position.y);
  } else if (Array.isArray(position) && position.length >= 2) {
    x = Number(position[0]);
    y = Number(position[1]);
  } else if (typeof position === "string") {
    const trimmed = position.trim();
    const dotParts = trimmed.split(".");
    if (dotParts.length === 2 && /^-?\d+$/.test(dotParts[0]) && /^-?\d+$/.test(dotParts[1])) {
      x = Number(dotParts[0]);
      y = Number(dotParts[1]);
    } else {
      const nums = trimmed.match(/-?\d+(\.\d+)?/g)?.map(Number) || [];
      if (nums.length >= 2) {
        x = nums[0];
        y = nums[1];
      }
    }
  }

  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function templatePositionToRect(position) {
  const parsed = parseTemplatePosition(position);
  if (!parsed) return null;

  let x = parsed.x;
  let y = parsed.y;
  const gridSize = canvas.grid.size;
  const sceneWidthCells = Math.ceil(canvas.dimensions.width / gridSize);
  const sceneHeightCells = Math.ceil(canvas.dimensions.height / gridSize);
  const looksLikeCellCoords = Math.abs(x) <= sceneWidthCells + 10 && Math.abs(y) <= sceneHeightCells + 10 && Math.abs(x % 1) < 0.001 && Math.abs(y % 1) < 0.001;

  if (looksLikeCellCoords) {
    x *= gridSize;
    y *= gridSize;
  }

  return { left: x, top: y, right: x + gridSize, bottom: y + gridSize };
}

function getTokenBaseRect(token) {
  const gridSize = canvas.grid.size;
  const width = Math.max(1, Number(token.document.width ?? 1));
  const height = Math.max(1, Number(token.document.height ?? 1));

  return {
    left: Number(token.document.x),
    top: Number(token.document.y),
    right: Number(token.document.x) + width * gridSize,
    bottom: Number(token.document.y) + height * gridSize
  };
}

function rectsOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function tokenTouchesAuraCellRects(auraCellRects, targetToken) {
  const tokenRect = getTokenBaseRect(targetToken);
  return auraCellRects.some(cellRect => rectsOverlap(tokenRect, cellRect));
}

function nearlySame(a, b) {
  return Math.abs(Number(a) - Number(b)) < 1;
}

async function waitForCanvasTemplate(templateId, delay = 40) {
  await sleep(delay);
  return canvas.templates.placeables.find(t => t.id === templateId);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
