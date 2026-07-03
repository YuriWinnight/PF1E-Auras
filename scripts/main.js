/*
 * Pathfinder 1e Auras v0.1.17
 * Foundry VTT 11.315 / PF1e first playable version, negative aura source toggle decoupling patch.
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
  hoveredTokenIds: new Set(),
  tickRequestTimes: new Map(),
  queuedTick: null,
  queuedTickAt: 0,
  pendingTick: false,
  lastTickFinishedAt: 0,
  deletingTemplateIds: new Set(),
  creatingAuraCopyKeys: new Set()
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
    default: 250,
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
  patchPF1ApplyChangesForNegativeAuras();
  startIfResponsibleGM();
});

Hooks.on("canvasReady", () => {
  startIfResponsibleGM();
  queueTick();
  window.setTimeout(() => updateHoverOnlyTemplateVisibility(), 100);
  window.setTimeout(() => refreshLocalAuraActorEffects(), 250);
});

Hooks.on("hoverToken", (token, hovered) => {
  if (!token?.id) return;

  if (hovered) PPA.hoveredTokenIds.add(token.id);
  else PPA.hoveredTokenIds.delete(token.id);

  updateHoverOnlyTemplateVisibility();
});

Hooks.on("createMeasuredTemplate", () => window.setTimeout(() => updateHoverOnlyTemplateVisibility(), 50));

Hooks.on("updateItem", async (item, changed) => {
  const aura = getAuraConfig(item);
  const copy = getAuraCopyConfig(item);

  // Негативная аура не должна применять свои system.changes к источнику.
  // Поэтому обычная PF1e-активность используется как триггер, а реальное
  // состояние ауры хранится отдельно во flags: negativeAuraActive.
  // Так изменения предмета остаются внутри эффекта и нормально копируются на цели.
  if (aura?.isAura === true && aura?.isNegative === true && !copy && changed?.system?.active === true) {
    await handleNegativeAuraActiveToggle(item, aura);
    return;
  }

  if (aura?.isAura || changed?.flags?.[PPA.ID]) {
    queueTick();
    requestGmTick("updateItem", 25, 100);
  } else if (copy) {
    queueTick(100);
    requestGmTick("updateAuraCopy", 150, 300);
  }
});

Hooks.on("updateActor", (actor, changed) => {
  // PF1e иногда обновляет состояние листа через актёра, а не через явный updateItem.
  // Просим активного ГМа пересчитать ауры после такого обновления.
  if (changed?.items || changed?.flags) {
    queueTick();
    requestGmTick("updateActor", 50, 150);
  } else if (changed?.system) {
    queueTick(250);
    requestGmTick("updateActorSystem", 250, 500);
  }
});

Hooks.on("deleteItem", item => {
  if (!getAuraConfig(item) && !getAuraCopyConfig(item)) return;
  queueTick();
  requestGmTick("deleteItem", 25, 100);
});
Hooks.on("updateToken", (tokenDocument, changed) => {
  if (!isTokenUpdateAuraRelevant(changed)) return;
  queueTick(50);
  requestGmTick("updateToken", 75, 150);
});
Hooks.on("createToken", () => { queueTick(15); requestGmTick("createToken", 50); });
Hooks.on("deleteToken", tokenDocument => {
  const sourceIds = getDeletedTokenSourceIds(tokenDocument);
  cleanupAurasForDeletedSource(sourceIds);
  window.setTimeout(() => cleanupAurasForDeletedSource(sourceIds), 150);
  queueTick(50);
  requestGmTick("deleteToken", 75, 150);
});
Hooks.on("deleteActor", actor => {
  const sourceIds = { sourceActorId: actor?.id, matchActorOnly: true };
  cleanupAurasForDeletedSource(sourceIds);
  window.setTimeout(() => cleanupAurasForDeletedSource(sourceIds), 150);
  requestGmTick("deleteActor", 75, 150);
});
Hooks.on("updateMeasuredTemplate", () => {
  window.setTimeout(() => updateHoverOnlyTemplateVisibility(), 25);
});
Hooks.on("refreshMeasuredTemplate", templateObject => {
  const cfg = getTemplateVisualConfig(templateObject);
  if (!cfg) return;
  enforceAuraTemplateRuler(templateObject, cfg);
  Promise.resolve().then(() => enforceAuraTemplateRuler(templateObject, cfg));
});
Hooks.on("deleteMeasuredTemplate", templateDocument => {
  if (getTemplateFlag(templateDocument)) queueTick(100);
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
          console.error("Pathfinder 1e Auras: failed to inject item sheet controls", err);
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
    console.error("Pathfinder 1e Auras: failed to prepare item sheet controls", err);
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
  if (game.settings.get(PPA.ID, "debug")) console.log("Pathfinder 1e Auras:", ...args);
}

function isMissingEmbeddedDocumentError(err) {
  const msg = String(err?.message || err || "");
  return msg.includes("does not exist")
    || msg.includes("EmbeddedCollectionDelta")
    || msg.includes("undefined id");
}

function registerSocketListener() {
  try {
    game.socket?.on?.(`module.${PPA.ID}`, data => {
      if (!data) return;
      if (data.type === "refreshAuraActorEffects") {
        if (data.sceneId && data.sceneId !== canvas?.scene?.id) return;
        refreshLocalAuraActorEffects(data.tokenIds);
        return;
      }
      if (data.type !== "requestTick") return;
      if (!isResponsibleGM()) return;

      // Запускаем несколько пересчётов с маленькой задержкой: при клике игрока
      // данные Item/Actor могут прийти ГМу на долю секунды позже socket-сообщения.
      const reason = String(data.reason || "unknown");
      queueTick(Number(data.delay ?? 25));
      queueFollowUpTick(150);
      if (reason !== "updateToken" && reason !== "updateActorSystem" && reason !== "updateAuraCopy") {
        queueFollowUpTick(350);
      }
      debugLog("GM tick requested by socket", data.reason || "unknown");
    });
  } catch (err) {
    console.warn("Pathfinder 1e Auras: cannot register socket listener", err);
  }
}

function requestGmTick(reason = "unknown", delay = 25, throttleMs = 0) {
  try {
    if (throttleMs > 0) {
      const sceneId = canvas?.scene?.id || "no-scene";
      const key = `${reason}:${sceneId}`;
      const now = Date.now();
      const last = PPA.tickRequestTimes.get(key) || 0;
      if (now - last < throttleMs) return;
      PPA.tickRequestTimes.set(key, now);
    }

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
    console.warn("Pathfinder 1e Auras: cannot request GM tick", err);
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

  const tickMs = getConfiguredTickMs();
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
  if (PPA.running) {
    PPA.pendingTick = true;
    return;
  }

  const now = Date.now();
  const numericDelay = Math.max(0, Number(delay) || 0);
  const minGap = getMinTickGapMs();
  const runAt = Math.max(now + numericDelay, (PPA.lastTickFinishedAt || 0) + minGap);

  if (PPA.queuedTick && PPA.queuedTickAt && PPA.queuedTickAt <= runAt + 5) return;

  window.clearTimeout(PPA.queuedTick);
  PPA.queuedTickAt = runAt;
  PPA.queuedTick = window.setTimeout(() => {
    PPA.queuedTick = null;
    PPA.queuedTickAt = 0;
    tickAuras();
  }, Math.max(0, runAt - Date.now()));
}

function queueFollowUpTick(delay = 150) {
  if (!isResponsibleGM()) return;
  window.setTimeout(() => queueTick(0), Math.max(0, Number(delay) || 0));
}

function getConfiguredTickMs(fallback = 250) {
  try {
    return Number(game.settings.get(PPA.ID, "tickMs")) || fallback;
  } catch (_) {
    return fallback;
  }
}

function getMinTickGapMs() {
  const configured = getConfiguredTickMs();
  return Math.max(50, Math.min(250, configured));
}

function isTokenUpdateAuraRelevant(changed = {}) {
  if (!changed || typeof changed !== "object") return true;
  const directKeys = ["x", "y", "width", "height", "disposition", "actorId"];
  if (directKeys.some(key => changed[key] !== undefined)) return true;
  return changed.flags?.[PPA.ID] !== undefined;
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
        console.warn("Pathfinder 1e Auras: cannot read current flag scope", scope, err);
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

async function safeSetAuraFlag(item, cfg) {
  try {
    await item?.setFlag?.(PPA.ID, PPA.FLAG_AURA, cfg);
    return true;
  } catch (err) {
    if (!isMissingEmbeddedDocumentError(err)) {
      console.warn("Pathfinder 1e Auras: cannot update aura flag", err);
    }
    return false;
  }
}

async function handleNegativeAuraActiveToggle(item, cfg) {
  try {
    const currentlyAuraActive = cfg?.negativeAuraActive === true;
    const nextAuraActive = !currentlyAuraActive;

    const nextCfg = {
      ...cfg,
      negativeAuraActive: nextAuraActive
    };

    await item.setFlag(PPA.ID, PPA.FLAG_AURA, nextCfg);

    // Важно: сам PF1e-эффект источника всегда остаётся неактивным,
    // иначе PF1e применит его изменения к владельцу.
    if (item.system?.active === true) {
      await item.update({ "system.active": false });
    }

    ui.notifications.info(nextAuraActive
      ? `Негативная аура «${item.name}» включена. Эффект не применяется к источнику.`
      : `Негативная аура «${item.name}» выключена.`);

    queueTick(10);
    requestGmTick("negativeAuraActiveToggle", 50);
  } catch (err) {
    console.error("Pathfinder 1e Auras: failed to toggle negative aura active state", err);
  }
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

  if (cfg?.isNegative === true) {
    // Негативные ауры активируются отдельным флагом, чтобы исходный PF1e-эффект
    // не применял свои изменения к источнику.
    return cfg.negativeAuraActive === true;
  }

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
  const negativeText = cfg.isNegative ? " · негативный эффект" : "";
  const negativeActiveText = cfg.isNegative ? ` · негативная аура ${cfg.negativeAuraActive ? "включена" : "выключена"}` : "";
  const summary = configured
    ? `Радиус: ${Number(cfg.radiusFeet) || 10} футов · ${displayModeLabel(cfg.displayMode)}${negativeText}${negativeActiveText}${hoverText}`
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
      <div class="pod-pyvo-aura-row pod-pyvo-negative-row" style="display:${isAura ? "block" : "none"};">
        <label>
          <input type="checkbox" class="pod-pyvo-is-negative" ${cfg.isNegative ? "checked" : ""}/>
          Негативный эффект
        </label>
        <p class="notes">Негативная аура передаётся вражеским командам вместо союзников. Исходный PF1e-эффект на источнике держится выключенным, чтобы его изменения не применялись к владельцу.</p>
        <div class="pod-pyvo-negative-active-controls" style="display:${cfg.isNegative ? "block" : "none"}; margin-top: 6px;">
          <button type="button" class="pod-pyvo-toggle-negative-active">
            <i class="fas fa-power-off"></i> ${cfg.negativeAuraActive ? "Выключить негативную ауру" : "Включить негативную ауру"}
          </button>
        </div>
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
      const oldCfg = getAuraConfig(item) || {};
      await restoreNegativeSourceItem(item, oldCfg);
      await item.unsetFlag(PPA.ID, PPA.FLAG_AURA);
      app.render(false);
      queueTick(10);
      requestGmTick("auraUnconfigured", 50);
    }
  });

  block.find(".pod-pyvo-is-negative").on("change", async ev => {
    const fresh = getAuraConfig(item) || {};
    if (!fresh.isAura) {
      ev.currentTarget.checked = false;
      ui.notifications.warn("Сначала включи «Является аурой».");
      return;
    }

    const checked = ev.currentTarget.checked === true;
    const nextCfg = {
      ...fresh,
      isNegative: checked,
      negativeAuraActive: checked ? (fresh.negativeAuraActive === true) : false
    };

    await item.setFlag(PPA.ID, PPA.FLAG_AURA, nextCfg);

    if (!checked) await restoreNegativeSourceItem(item, fresh);

    // Если эффект уже был активен как обычный PF1e-бафф и его переводят
    // в негативную ауру, выключаем сам предмет и включаем ауру через флаг.
    if (checked && item.system?.active === true) {
      await item.setFlag(PPA.ID, PPA.FLAG_AURA, { ...nextCfg, negativeAuraActive: true });
      await item.update({ "system.active": false });
    }

    app.render(false);
    queueTick(10);
    requestGmTick("negativeAuraChanged", 50);
  });

  block.find(".pod-pyvo-toggle-negative-active").on("click", async () => {
    const fresh = getAuraConfig(item) || {};
    if (!fresh.isAura || !fresh.isNegative) {
      ui.notifications.warn("Сначала включи «Является аурой» и «Негативный эффект».");
      return;
    }

    await item.setFlag(PPA.ID, PPA.FLAG_AURA, {
      ...fresh,
      negativeAuraActive: fresh.negativeAuraActive !== true
    });

    if (item.system?.active === true) {
      await item.update({ "system.active": false });
    }

    app.render(false);
    queueTick(10);
    requestGmTick("negativeAuraActiveButton", 50);
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
        r10: { label: "10 футов", callback: html => resolve(readAuraDialog(html, 10, oldConfig)) },
        r20: { label: "20 футов", callback: html => resolve(readAuraDialog(html, 20, oldConfig)) },
        r30: { label: "30 футов", callback: html => resolve(readAuraDialog(html, 30, oldConfig)) },
        r60: { label: "60 футов", callback: html => resolve(readAuraDialog(html, 60, oldConfig)) },
        custom: {
          label: "Своё",
          callback: html => {
            const value = Number(html.find('[name="radius"]').val());
            resolve(readAuraDialog(html, Number.isFinite(value) && value > 0 ? value : defaultRadius, oldConfig));
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

function readAuraDialog(html, radiusFeet, oldConfig = {}) {
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
    isNegative: oldConfig.isNegative === true,
    negativeAuraActive: oldConfig.negativeAuraActive === true,
    selfSuppression: oldConfig.selfSuppression || null,
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

function getTokenDisposition(token) {
  const value = token?.document?.disposition
    ?? token?.document?._source?.disposition
    ?? token?.data?.disposition
    ?? token?.data?.data?.disposition
    ?? null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}

function isFriendlyToken(token) {
  const friendly = globalThis.CONST?.TOKEN_DISPOSITIONS?.FRIENDLY ?? 1;
  return getTokenDisposition(token) === friendly;
}

function isHostileToken(token) {
  const hostile = globalThis.CONST?.TOKEN_DISPOSITIONS?.HOSTILE ?? -1;
  return getTokenDisposition(token) === hostile;
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

function isTargetReceiverForAura(token, cfg = {}) {
  const role = getEffectiveRole(token);
  if (role === "receiver" || role === "source-receiver") return true;
  if (role === "source" || role === "none") return false;

  if (cfg?.isNegative === true) {
    // Для негативных аур авто-цели могут быть как партией, так и враждебными токенами.
    // Если ГМ явно назначил токену команду, авто-роль тоже разрешает получать негативную ауру.
    return !!getExplicitTeamId(token) || isAutoPartyToken(token) || isHostileToken(token);
  }

  return isAutoPartyToken(token);
}

function getNegativeRelationTeamId(token) {
  const explicit = getExplicitTeamId(token);
  if (explicit) return explicit;
  if (isHostileToken(token)) return "hostile";
  if (isAutoPartyToken(token)) return "party";
  return null;
}

function canAuraAffectTarget(sourceToken, targetToken, cfg = {}) {
  if (!sourceToken || !targetToken) return false;
  if (sourceToken.id === targetToken.id) return false;
  if (!isTargetReceiverForAura(targetToken, cfg)) return false;

  if (cfg?.isNegative === true) {
    const sourceTeam = getNegativeRelationTeamId(sourceToken);
    const targetTeam = getNegativeRelationTeamId(targetToken);

    if (!sourceTeam || !targetTeam) return false;
    return sourceTeam !== targetTeam;
  }

  const sourceTeam = getEffectiveTeamId(sourceToken);
  const targetTeam = getEffectiveTeamId(targetToken);

  if (!sourceTeam || !targetTeam) return false;
  return sourceTeam === targetTeam;
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
  if (!game.user?.isGM) {
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


function getDeletedTokenSourceIds(tokenDocument) {
  return {
    sourceTokenId: tokenDocument?.id || tokenDocument?._id || null,
    sourceActorId: tokenDocument?.actor?.id || tokenDocument?.actorId || null,
    matchActorOnly: false
  };
}

function auraSourceMatches(sourceData = {}, sourceIds = {}) {
  const sourceTokenId = sourceIds.sourceTokenId || null;
  const sourceActorId = sourceIds.sourceActorId || null;

  if (sourceTokenId) return sourceData.sourceTokenId === sourceTokenId;
  if (sourceIds.matchActorOnly === true && sourceActorId) return sourceData.sourceActorId === sourceActorId;
  return false;
}

async function cleanupAurasForDeletedSource(sourceIds = {}) {
  if (!isResponsibleGM()) return;
  if (!canvas?.scene || !canvas?.templates || !canvas?.tokens) return;
  if (!sourceIds.sourceTokenId && !sourceIds.sourceActorId) return;

  try {
    const auraTemplates = canvas.templates.placeables.filter(templateObject => {
      const flag = getTemplateFlag(templateObject?.document);
      if (!flag?.template) return false;
      return auraSourceMatches(flag, sourceIds);
    });

    if (auraTemplates.length) {
      await safeDeleteMeasuredTemplates(auraTemplates.map(t => t.id));
    }

    await deleteAuraCopiesForDeletedSource(sourceIds);
  } catch (err) {
    console.warn("Pathfinder 1e Auras: failed to clean deleted source auras", err);
  }
}

async function deleteAuraCopiesForDeletedSource(sourceIds = {}) {
  const seenActorIds = new Set();

  for (const token of canvas.tokens.placeables || []) {
    const actor = token?.actor;
    if (!actor || seenActorIds.has(actor.id)) continue;
    seenActorIds.add(actor.id);

    const copies = actor.items.filter(item => {
      const copy = getAuraCopyConfig(item);
      if (!copy || copy.sceneId !== canvas.scene.id) return false;
      return auraSourceMatches(copy, sourceIds);
    });

    await deleteCopiedAuraItems(actor, copies);
  }
}

function duplicateData(value) {
  try {
    if (foundry?.utils?.duplicate) return foundry.utils.duplicate(value);
  } catch (_) {}
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return value;
  }
}

function shouldSuppressNegativeAuraOnSourceItem(item) {
  const cfg = getAuraConfig(item);
  if (!cfg?.isAura || cfg?.isNegative !== true) return false;
  if (getAuraCopyConfig(item)) return false;
  if (item.system?.active !== true) return false;
  return true;
}

function patchPF1ApplyChangesForNegativeAuras() {
  try {
    const changesApi = globalThis.pf1?.documents?.actor?.changes;
    if (!changesApi?.applyChanges || changesApi.applyChanges._pf1eAurasPatched) return;

    const originalApplyChanges = changesApi.applyChanges;

    const patchedApplyChanges = function(actor, options = {}) {
      const suppressed = [];

      try {
        for (const item of actor?.items || []) {
          if (!shouldSuppressNegativeAuraOnSourceItem(item)) continue;

          const currentChanges = item.system?.changes;
          if (!Array.isArray(currentChanges) || currentChanges.length === 0) continue;

          suppressed.push({ item, changes: currentChanges });

          // Важно: это только временная память на время подготовки данных актёра.
          // Мы НЕ делаем item.update и НЕ удаляем изменения из настоящего предмета.
          item.system.changes = [];
        }

        return originalApplyChanges.call(this, actor, options);
      } finally {
        for (const entry of suppressed) {
          try {
            entry.item.system.changes = entry.changes;
          } catch (_) {}
        }
      }
    };

    patchedApplyChanges._pf1eAurasPatched = true;
    patchedApplyChanges._pf1eAurasOriginal = originalApplyChanges;
    changesApi.applyChanges = patchedApplyChanges;

    console.log("Pathfinder 1e Auras: PF1 applyChanges patched for negative aura source suppression.");
  } catch (err) {
    console.warn("Pathfinder 1e Auras: cannot patch PF1 applyChanges; negative auras may still affect their source.", err);
  }
}

async function restoreNegativeSourceItem(item, cfg = {}) {
  const storedChanges = cfg?.selfSuppression?.systemChanges;
  if (!storedChanges) return;

  const currentChanges = duplicateData(item.system?.changes || []);
  const hasCurrentChanges = Array.isArray(currentChanges) && currentChanges.length > 0;

  const nextCfg = { ...cfg };
  delete nextCfg.selfSuppression;

  try {
    // Миграция со старой версии 0.1.9: если она уже успела очистить изменения
    // на источнике, возвращаем их один раз. В новых версиях изменения больше
    // не удаляются из предмета вообще.
    if (!hasCurrentChanges && Array.isArray(storedChanges)) {
      try {
        await item.update({ "system.changes": duplicateData(storedChanges) });
      } catch (err) {
        if (!isMissingEmbeddedDocumentError(err)) throw err;
        return;
      }
    }

    await safeSetAuraFlag(item, nextCfg);
  } catch (err) {
    if (!isMissingEmbeddedDocumentError(err)) {
      console.warn("Pathfinder 1e Auras: failed to restore negative aura source item", err);
    }
  }
}

function applyAuraSourceDataToCopy(itemData, cfg = {}) {
  const storedChanges = cfg?.selfSuppression?.systemChanges;

  // Совместимость с копиями из 0.1.9: если исходный предмет уже был случайно
  // очищен старой версией, используем сохранённые изменения для копии.
  if (cfg?.isNegative === true && Array.isArray(storedChanges)) {
    const currentCopyChanges = itemData.system?.changes;
    const copyHasChanges = Array.isArray(currentCopyChanges) && currentCopyChanges.length > 0;

    if (!copyHasChanges) {
      itemData.system = itemData.system || {};
      itemData.system.changes = duplicateData(storedChanges);
    }
  }

  return itemData;
}

async function tickAuras() {
  if (!isResponsibleGM()) return;
  if (!canvas?.scene || !canvas?.tokens) return;
  if (PPA.running) {
    PPA.pendingTick = true;
    return;
  }

  PPA.running = true;
  PPA.pendingTick = false;
  window.clearTimeout(PPA.queuedTick);
  PPA.queuedTick = null;
  PPA.queuedTickAt = 0;

  try {
    const activeAuras = [];
    const tokens = canvas.tokens.placeables.filter(t => t?.actor);

    for (const sourceToken of tokens) {
      for (const sourceItem of sourceToken.actor.items) {
        if (!isAuraEnabledItem(sourceItem)) {
          const cfg = getAuraConfig(sourceItem);
          if (cfg?.selfSuppression) await restoreNegativeSourceItem(sourceItem, cfg);
          if (cfg?.templateId && cfg.sceneId === canvas.scene.id) {
            await deleteAuraTemplateById(cfg.templateId);
            await safeSetAuraFlag(sourceItem, { ...cfg, templateId: null });
          }
          continue;
        }

        let cfg = getAuraConfig(sourceItem);
        if (cfg?.selfSuppression) {
          await restoreNegativeSourceItem(sourceItem, cfg);
          cfg = getAuraConfig(sourceItem);
        }
        const templateObject = await ensureAuraTemplate(sourceToken, sourceItem, cfg);
        const auraCellRects = getAuraCellRectsFromTemplate(templateObject);
        applyTemplateVisualMode(templateObject, cfg);

        activeAuras.push({ sourceToken, sourceItem, cfg, templateObject, auraCellRects });
      }
    }

    await cleanupOrphanAuraTemplates(activeAuras);
    await updateAuraCopies(tokens, activeAuras);
  } catch (err) {
    console.error("Pathfinder 1e Auras: aura tick failed", err);
  } finally {
    PPA.running = false;
    PPA.lastTickFinishedAt = Date.now();
    if (PPA.pendingTick) {
      PPA.pendingTick = false;
      queueTick(getMinTickGapMs());
    }
  }
}

async function updateAuraCopies(tokens, activeAuras) {
  const actorTokenGroups = new Map();

  for (const token of tokens) {
    if (!token.actor) continue;
    const actorKey = getAuraTargetActorKey(token);
    if (!actorTokenGroups.has(actorKey)) actorTokenGroups.set(actorKey, []);
    actorTokenGroups.get(actorKey).push(token);
  }

  for (const [actorKey, targetTokens] of actorTokenGroups.entries()) {
    const actor = targetTokens[0]?.actor;
    if (!actor) continue;

    const validAurasByKey = new Map();

    for (const aura of activeAuras) {
      const affectsAnyToken = targetTokens.some(targetToken => {
        if (!canAuraAffectTarget(aura.sourceToken, targetToken, aura.cfg)) return false;
        return tokenTouchesAuraCellRects(aura.auraCellRects, targetToken);
      });

      if (affectsAnyToken) {
        const key = getAuraSourceKey({
          sceneId: canvas.scene.id,
          sourceTokenId: aura.sourceToken.id,
          sourceItemId: aura.sourceItem.id
        });
        if (!validAurasByKey.has(key)) validAurasByKey.set(key, aura);
      }
    }

    const copies = Array.from(actor.items || []).filter(i => getAuraCopyConfig(i));
    const retainedCopies = new Map();
    const toDelete = [];

    for (const copyItem of copies) {
      const copyKey = getAuraSourceKey(getAuraCopyConfig(copyItem));
      if (!copyKey || !validAurasByKey.has(copyKey) || retainedCopies.has(copyKey)) {
        toDelete.push(copyItem);
        continue;
      }
      retainedCopies.set(copyKey, copyItem);
    }

    await deleteCopiedAuraItems(actor, toDelete);

    for (const [key, aura] of validAurasByKey.entries()) {
      let existing = retainedCopies.get(key) || null;

      if (!existing) {
        const creationKey = `${actorKey}:${key}`;
        if (PPA.creatingAuraCopyKeys.has(creationKey)) continue;

        PPA.creatingAuraCopyKeys.add(creationKey);
        try {
          const concurrentExisting = Array.from(actor.items || []).find(item => {
            return getAuraSourceKey(getAuraCopyConfig(item)) === key;
          });

          if (concurrentExisting) {
            existing = concurrentExisting;
          } else {
            let itemData = aura.sourceItem.toObject();
            delete itemData._id;
            itemData = applyAuraSourceDataToCopy(itemData, aura.cfg);
            itemData = stripAuraSourceDataFromCopy(itemData);
            itemData.flags = itemData.flags || {};
            itemData.flags[PPA.ID] = itemData.flags[PPA.ID] || {};
            itemData.flags[PPA.ID][PPA.FLAG_COPY] = {
              sceneId: canvas.scene.id,
              sourceTokenId: aura.sourceToken.id,
              sourceActorId: aura.sourceToken.actor.id,
              sourceItemId: aura.sourceItem.id,
              sourceItemName: aura.sourceItem.name,
              teamId: getEffectiveTeamId(aura.sourceToken),
              isNegative: aura.cfg?.isNegative === true
            };
            itemData.name = `${aura.sourceItem.name}`;
            setProperty(itemData, "system.active", true);

            const created = await actor.createEmbeddedDocuments("Item", [itemData]);
            existing = created[0] || null;
            debugLog("Aura copied", aura.sourceItem.name, "to", targetTokens[0]?.name || actor.name);
          }
        } finally {
          PPA.creatingAuraCopyKeys.delete(creationKey);
        }
      }

      if (existing?.system?.active !== true) {
        try {
          await existing.update({ "system.active": true });
        } catch (err) {
          if (!isMissingEmbeddedDocumentError(err)) throw err;
          refreshActorAfterAuraCopyChange(actor);
        }
      }
    }
  }
}

function getAuraTargetActorKey(token) {
  const actor = token?.actor;
  const isSynthetic = actor?.isToken === true || token?.document?.actorLink === false;
  if (isSynthetic) return `token:${token?.id || actor?.uuid || actor?.id}`;
  return `actor:${actor?.id || token?.document?.actorId || token?.id}`;
}

function getAuraSourceKey(copy = {}) {
  const sceneId = copy?.sceneId;
  const sourceTokenId = copy?.sourceTokenId;
  const sourceItemId = copy?.sourceItemId;
  if (!sceneId || !sourceTokenId || !sourceItemId) return null;
  return `${sceneId}:${sourceTokenId}:${sourceItemId}`;
}

function stripAuraSourceDataFromCopy(itemData) {
  for (const scope of [PPA.ID, ...(PPA.LEGACY_IDS || [])]) {
    if (itemData.flags?.[scope]) {
      delete itemData.flags[scope][PPA.FLAG_AURA];
    }
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
  if (!ids.length) return;

  for (const id of ids) {
    try {
      const item = getActorItem(actor, id);
      if (!item) continue;

      if (typeof item.delete === "function") {
        await item.delete();
      } else {
        await actor.deleteEmbeddedDocuments("Item", [id]);
      }
    } catch (err) {
      if (isMissingEmbeddedDocumentError(err)) continue;
      console.warn("Pathfinder 1e Auras: cannot delete aura copy", id, err);
    }
  }

  refreshActorAfterAuraCopyChange(actor);
}

function refreshActorAfterAuraCopyChange(actor) {
  try {
    actor?.prepareData?.();
  } catch (err) {
    console.warn("Pathfinder 1e Auras: cannot refresh actor after aura cleanup", err);
  }

  try {
    actor?.render?.(false);
  } catch (_) {}

  const tokenIds = getCanvasTokenIdsForActor(actor);
  refreshLocalAuraActorEffects(tokenIds);

  try {
    game.socket?.emit?.(`module.${PPA.ID}`, {
      type: "refreshAuraActorEffects",
      sceneId: canvas?.scene?.id || null,
      tokenIds
    });
  } catch (_) {}
}

function getCanvasTokenIdsForActor(actor) {
  if (!actor || !canvas?.tokens?.placeables) return [];

  return canvas.tokens.placeables
    .filter(token => {
      if (token?.actor === actor) return true;
      if (actor.isToken === true || token?.actor?.isToken === true) return false;
      return token?.actor?.id === actor.id;
    })
    .map(token => token.id)
    .filter(Boolean);
}

function refreshLocalAuraActorEffects(tokenIds = null) {
  if (!canvas?.tokens?.placeables) return;
  const wantedIds = Array.isArray(tokenIds) ? new Set(tokenIds) : null;
  const preparedActors = new Set();

  for (const token of canvas.tokens.placeables) {
    if (wantedIds && !wantedIds.has(token.id)) continue;
    const actor = token?.actor;
    const actorKey = getAuraTargetActorKey(token);

    if (actor && !preparedActors.has(actorKey)) {
      preparedActors.add(actorKey);
      try {
        actor.prepareData?.();
        actor.render?.(false);
      } catch (_) {}
    }

    try {
      const drawing = token.drawEffects?.();
      drawing?.catch?.(() => {});
    } catch (_) {}
  }
}

function getActorItem(actor, id) {
  if (!actor || !id || !actor.items) return null;

  try {
    return actor.items.get?.(id) || null;
  } catch (_) {}

  try {
    return Array.from(actor.items || []).find(item => item?.id === id) || null;
  } catch (_) {
    return null;
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

function templateConfigMatches(current = {}, expected = {}) {
  const keys = Object.keys(expected);
  if (!current || typeof current !== "object") return false;
  return keys.every(key => current[key] === expected[key]);
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
      console.warn("Pathfinder 1e Auras: cannot update hover-only aura template visibility", err);
    }
  }
}

async function ensureAuraTemplate(sourceToken, sourceItem, cfg) {
  let templateId = cfg.templateId || null;
  let templateObject = templateId ? canvas.templates.placeables.find(t => t.id === templateId) : null;
  const radiusFeet = Number(cfg.radiusFeet) || 10;
  const desiredConfig = getTemplateConfigSnapshot(cfg);

  if (templateId && !templateObject) {
    await safeSetAuraFlag(sourceItem, { ...cfg, templateId: null });
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
          config: desiredConfig
        }
      }
    }]);

    templateId = created[0].id;
    await safeSetAuraFlag(sourceItem, {
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
  const currentFlag = templateObject.document.flags?.[PPA.ID] || {};
  if (!templateConfigMatches(currentFlag.config, desiredConfig)) updates[`flags.${PPA.ID}.config`] = desiredConfig;
  if (currentFlag.sourceTokenId !== sourceToken.id) updates[`flags.${PPA.ID}.sourceTokenId`] = sourceToken.id;
  if (currentFlag.sourceActorId !== sourceToken.actor.id) updates[`flags.${PPA.ID}.sourceActorId`] = sourceToken.actor.id;
  if (currentFlag.sourceItemId !== sourceItem.id) updates[`flags.${PPA.ID}.sourceItemId`] = sourceItem.id;
  if (currentFlag.template !== true) updates[`flags.${PPA.ID}.template`] = true;

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
  const pending = unique.filter(id => !PPA.deletingTemplateIds.has(id));
  const existing = pending.filter(id => sceneHasMeasuredTemplate(id));
  for (const id of unique.filter(id => !existing.includes(id))) removeAuraVisual(id);
  if (!existing.length) return;

  for (const id of existing) PPA.deletingTemplateIds.add(id);

  try {
    await canvas.scene.deleteEmbeddedDocuments("MeasuredTemplate", existing);
  } catch (err) {
    for (const id of existing) {
      try {
        if (sceneHasMeasuredTemplate(id)) {
          await canvas.scene.deleteEmbeddedDocuments("MeasuredTemplate", [id]);
        }
      } catch (singleErr) {
        const msg = String(singleErr?.message || singleErr || "");
        if (!msg.includes("does not exist")) console.warn("Pathfinder 1e Auras: cannot delete template", id, singleErr);
      }
    }
  } finally {
    for (const id of existing) PPA.deletingTemplateIds.delete(id);
  }

  for (const id of existing) removeAuraVisual(id);
}

function sceneHasMeasuredTemplate(id) {
  if (!id || !canvas?.scene?.templates) return false;

  try {
    if (typeof canvas.scene.templates.has === "function") return canvas.scene.templates.has(id);
  } catch (_) {}

  try {
    return !!canvas.scene.templates.get?.(id);
  } catch (_) {
    return false;
  }
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
    enforceAuraTemplateRuler(templateObject, { ...cfg, showLabel: false });

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
  enforceAuraTemplateRuler(templateObject, cfg);

  updateAuraVisualCircle(templateObject, cfg);
}

function enforceAuraTemplateRuler(templateObject, cfg = {}) {
  const ruler = templateObject?.ruler;
  if (!ruler) return;

  const displayMode = cfg.displayMode || "circle-cells";
  const visible = cfg.showLabel === true && displayMode !== "hidden" && isAuraTemplateHoverVisible(templateObject, cfg);
  const radiusFeet = Number(cfg.radiusFeet) || Number(templateObject.document?.distance) || 10;
  const units = canvas.scene?.grid?.units || "ft";

  if (visible && "text" in ruler) ruler.text = `${radiusFeet} ${units}`;
  ruler.visible = visible;
  ruler.alpha = visible ? 1 : 0;
  ruler.renderable = visible;
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
      console.warn("Pathfinder 1e Auras: cannot read template cells", err);
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
