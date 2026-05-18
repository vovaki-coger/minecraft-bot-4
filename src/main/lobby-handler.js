/**
 * LobbyHandler v4 — автовыбор анки/ранга в лобби через компас или NPC.
 *
 * Что умеет:
 *  1. Определяет что бот попал в лобби (по заголовку Title, scoreboard или чату)
 *  2. Кликает компас в инвентаре → открывается меню ранга
 *  3. Ищет NPC по имени и взаимодействует с ним
 *  4. Выбирает нужный слот в открывшемся GUI
 */

const log = require("electron-log");

// Ключевые слова в Title/чате означающие что мы в лобби
const LOBBY_KEYWORDS = [
  "lobby", "лобби", "hub", "хаб", "waiting", "ожидание",
  "select", "выбор", "choose", "rank", "ранг", "анка", "class",
];

// Ключевые слова для сообщений о выборе класса/ранга
const RANK_SELECT_KEYWORDS = [
  "выбери", "выберите", "select your", "choose your", "pick your",
  "class", "rank", "kit", "кит", "роль", "role", "анку", "анк",
];

// NPC имена которые открывают меню ранга
const RANK_NPC_NAMES = [
  "ранг", "rank", "class", "kit", "кит", "класс", "выбор", "select",
  "анка", "анк", "role", "роль", "профессия", "profession",
];

class LobbyHandler {
  constructor(instance, emit) {
    this.instance = instance;
    this.emit = emit;
    this.inLobby = false;
    this.rankSelected = false;
    this.lobbyCheckTimer = null;
    this.windowListener = null;
    this.config = instance.config.lobbyConfig || {};
  }

  start() {
    const { bot } = this.instance;
    if (!bot) return;

    log.info("[LobbyHandler] Starting for bot", this.instance.id);

    // Слушаем открытие окон (GUI от сервера)
    this.windowListener = (window) => this._onWindowOpen(window);
    bot.on("windowOpen", this.windowListener);

    // Слушаем Title (крупный текст на экране)
    bot.on("title", (text) => this._onTitle(text));

    // Начинаем проверку лобби через 3 секунды после спавна
    this.lobbyCheckTimer = setTimeout(() => {
      this._checkAndHandleLobby();
    }, 3000);
  }

  stop() {
    if (this.lobbyCheckTimer) {
      clearTimeout(this.lobbyCheckTimer);
      this.lobbyCheckTimer = null;
    }
    if (this.windowListener && this.instance.bot) {
      this.instance.bot.removeListener("windowOpen", this.windowListener);
    }
    log.info("[LobbyHandler] Stopped");
  }

  onChatMessage(message) {
    const lower = message.toLowerCase();

    // Определяем лобби по сообщениям чата
    if (LOBBY_KEYWORDS.some(k => lower.includes(k))) {
      if (!this.inLobby) {
        log.info("[LobbyHandler] Detected lobby via chat:", message);
        this.inLobby = true;
      }
    }

    // Проверяем нужно ли выбрать ранг
    if (RANK_SELECT_KEYWORDS.some(k => lower.includes(k)) && !this.rankSelected) {
      log.info("[LobbyHandler] Rank selection prompt detected:", message);
      setTimeout(() => this._trySelectRank(), 1500);
    }
  }

  _onTitle(text) {
    if (!text) return;
    const lower = text.toLowerCase();
    if (LOBBY_KEYWORDS.some(k => lower.includes(k))) {
      log.info("[LobbyHandler] Detected lobby via title:", text);
      this.inLobby = true;
      if (!this.rankSelected) {
        setTimeout(() => this._trySelectRank(), 2000);
      }
    }
  }

  async _checkAndHandleLobby() {
    const { bot } = this.instance;
    if (!bot?.entity) return;

    // Проверяем наличие компаса в инвентаре (признак лобби на многих серверах)
    const compass = bot.inventory?.items().find(i =>
      i.name === "compass" || i.name === "clock"
    );
    if (compass && !this.rankSelected) {
      log.info("[LobbyHandler] Found compass/clock in lobby inventory");
      this.inLobby = true;
      await this._trySelectRank();
      return;
    }

    // Проверяем NPC в радиусе
    if (this.config.npcMode) {
      await this._tryFindAndClickNPC();
    }
  }

  async _trySelectRank() {
    if (this.rankSelected) return;
    const { bot } = this.instance;
    if (!bot?.entity) return;

    const mode = this.config.mode || "compass";

    if (mode === "compass" || mode === "auto") {
      const handled = await this._useCompass();
      if (handled) return;
    }

    if (mode === "npc" || mode === "auto") {
      await this._tryFindAndClickNPC();
    }
  }

  async _useCompass() {
    const { bot } = this.instance;
    if (!bot?.entity) return false;

    // Ищем компас или часы (часто используются вместо компаса)
    const COMPASS_ITEMS = ["compass", "clock", "watch", "nether_star", "paper", "book"];
    let compassItem = null;

    for (const itemName of COMPASS_ITEMS) {
      compassItem = bot.inventory?.items().find(i => i.name === itemName);
      if (compassItem) break;
    }

    if (!compassItem) {
      // Проверяем хотбар (слоты 36-44)
      for (let slot = 36; slot <= 44; slot++) {
        const item = bot.inventory?.slots[slot];
        if (item && COMPASS_ITEMS.includes(item.name)) {
          compassItem = item;
          break;
        }
      }
    }

    if (!compassItem) {
      log.info("[LobbyHandler] No compass/special item found in inventory");
      return false;
    }

    try {
      log.info("[LobbyHandler] Using item:", compassItem.name);
      await bot.equip(compassItem, "hand");
      await new Promise(r => setTimeout(r, 500));
      await bot.activateItem();
      await new Promise(r => setTimeout(r, 300));
      log.info("[LobbyHandler] Activated compass/item");
      return true;
    } catch (err) {
      log.warn("[LobbyHandler] Error using compass:", err.message);
      return false;
    }
  }

  async _tryFindAndClickNPC() {
    const { bot } = this.instance;
    if (!bot?.entity) return;

    // Ищем NPC по имени
    const entities = Object.values(bot.entities || {});
    const npcEntity = entities.find(e => {
      if (e === bot.entity) return false;
      const name = (e.displayName || e.name || e.username || "").toLowerCase();
      return RANK_NPC_NAMES.some(n => name.includes(n));
    });

    if (!npcEntity) {
      log.info("[LobbyHandler] No rank NPC found nearby");

      // Если конкретный NPC не найден — пробуем ближайшего виллейджера
      const villager = entities.find(e =>
        e !== bot.entity &&
        e.name === "villager" &&
        e.position?.distanceTo(bot.entity.position) < 20
      );

      if (villager) {
        log.info("[LobbyHandler] Trying nearest villager as rank NPC");
        await this._interactWithEntity(villager);
      }
      return;
    }

    log.info("[LobbyHandler] Found rank NPC:", npcEntity.displayName || npcEntity.name);
    await this._interactWithEntity(npcEntity);
  }

  async _interactWithEntity(entity) {
    const { bot } = this.instance;
    if (!bot?.entity || !entity?.position) return;

    try {
      const { goals } = require("mineflayer-pathfinder");
      const dist = entity.position.distanceTo(bot.entity.position);

      // Подходим если далеко
      if (dist > 4) {
        log.info("[LobbyHandler] Moving to NPC, distance:", dist);
        await bot.pathfinder.goto(
          new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2)
        ).catch(() => {});
        await new Promise(r => setTimeout(r, 500));
      }

      // Смотрим на NPC
      await bot.lookAt(entity.position.offset(0, 1, 0)).catch(() => {});
      await new Promise(r => setTimeout(r, 300));

      // Кликаем по NPC
      await bot.useOn(entity).catch(() => {});
      log.info("[LobbyHandler] Interacted with NPC");
    } catch (err) {
      log.warn("[LobbyHandler] Error interacting with entity:", err.message);
    }
  }

  async _onWindowOpen(window) {
    const title = window?.title || "";
    const lower = title.toLowerCase();

    log.info("[LobbyHandler] Window opened:", title, "slots:", window?.slots?.length);

    // Проверяем что это окно выбора ранга/класса
    const isRankWindow = RANK_SELECT_KEYWORDS.some(k => lower.includes(k)) ||
      LOBBY_KEYWORDS.some(k => lower.includes(k));

    if (!isRankWindow && this.config.rankWindowTitle) {
      // Проверяем кастомный заголовок из конфига
      const customTitle = this.config.rankWindowTitle.toLowerCase();
      if (!lower.includes(customTitle)) return;
    }

    if (!isRankWindow && !this.config.rankWindowTitle) {
      // Если заголовок не совпадает — всё равно пробуем если мы в лобби
      if (!this.inLobby) return;
    }

    log.info("[LobbyHandler] Rank selection window detected!");
    this.rankSelected = true;

    // Ждём немного для загрузки предметов в окне
    await new Promise(r => setTimeout(r, 800));

    const slotIndex = this.config.rankSlot ?? 0; // слот по умолчанию 0
    const targetRankName = this.config.rankName || null; // имя ранга если указано

    if (targetRankName && window.slots) {
      // Ищем конкретный ранг по имени
      const slot = window.slots.find(s =>
        s && (s.customName || s.displayName || s.name || "")
          .toLowerCase().includes(targetRankName.toLowerCase())
      );
      if (slot) {
        log.info("[LobbyHandler] Found rank by name:", slot.customName || slot.name);
        try {
          await window.click(slot.slot ?? slot.index ?? 0);
          this._emitRankSelected(slot.customName || slot.name);
        } catch (err) {
          log.warn("[LobbyHandler] Error clicking rank slot:", err.message);
        }
        return;
      }
    }

    // Кликаем по индексу слота
    try {
      await window.click(slotIndex);
      log.info("[LobbyHandler] Clicked rank slot:", slotIndex);
      this._emitRankSelected("слот " + slotIndex);
    } catch (err) {
      log.warn("[LobbyHandler] Error clicking slot:", err.message);
    }
  }

  _emitRankSelected(rankName) {
    log.info("[LobbyHandler] Rank selected:", rankName);
    this.emit("bot:chat", {
      botId: this.instance.id,
      username: "system",
      message: `✅ Анка/ранг выбран: ${rankName}`,
      type: "system",
    });
  }
}

module.exports = { LobbyHandler };
