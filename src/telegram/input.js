import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID } from '../config.js';
import { stripHtml } from './send.js';
import { now, parseNumericInput } from '../utils.js';
import { activeStrategy, setSetting, updateStrategyConfig } from '../db/settings.js';
import {
  filtersText,
  filtersKeyboard,
  numericFilterLabels,
  navKeyboard,
  strategyKeyboard,
  strategyMenuText,
  strategyNumericLabels,
} from './menus.js';

export const pendingNumericInputs = new Map();

export async function requestNumericFilterInput(query, key) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  if (!numericFilterLabels[key]) return bot.sendMessage(chatId, 'Unknown numeric filter.');
  pendingNumericInputs.set(String(chatId), {
    type: 'setting',
    key,
    at: now(),
    messageId: query.message?.message_id || null,
  });
  return editMenuMessage(
    query,
    `Send a number for ${numericFilterLabels[key]}.\nExamples: 5, 50000, 100k, 1.5m, off`,
    navKeyboard([[{ text: 'Cancel', callback_data: 'menu:filters' }]]),
  );
}

export async function requestStrategyNumericInput(query, key) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  if (!strategyNumericLabels[key]) return bot.sendMessage(chatId, 'Unknown strategy setting.');
  const strat = activeStrategy();
  pendingNumericInputs.set(String(chatId), {
    type: 'strategy',
    key,
    strategyId: strat.id,
    at: now(),
    messageId: query.message?.message_id || null,
  });
  return editMenuMessage(
    query,
    `Send a number for ${strat.name} ${strategyNumericLabels[key]}.\nExamples: 5, 50000, 100k, 1.5m, -40, off`,
    navKeyboard([[{ text: 'Cancel', callback_data: 'menu:strategy' }]]),
  );
}

export async function consumeNumericFilterInput(chatId, text, userMessageId = null) {
  const pending = pendingNumericInputs.get(String(chatId));
  if (!pending) return false;
  if (now() - pending.at > 5 * 60 * 1000) {
    pendingNumericInputs.delete(String(chatId));
    await bot.sendMessage(chatId, 'That input expired. Tap the filter input button again.');
    return true;
  }
  const value = parseNumericInput(text);
  if (value == null) {
    await bot.sendMessage(chatId, 'Invalid number. Try 5, 50000, 100k, 1.5m, or off.');
    return true;
  }
  pendingNumericInputs.delete(String(chatId));
  if (userMessageId) bot.deleteMessage(chatId, userMessageId).catch(() => {});
  if (pending.type === 'strategy') {
    const strat = activeStrategy();
    if (strat.id !== pending.strategyId) {
      await bot.sendMessage(chatId, 'Strategy changed while input was pending. Open Strategy menu and try again.');
      return true;
    }
    const newConfig = { ...strat, [pending.key]: value };
    delete newConfig.id;
    delete newConfig.name;
    updateStrategyConfig(strat.id, newConfig);
    if (pending.messageId) {
      await bot.editMessageText(stripHtml(strategyMenuText()), {
        chat_id: chatId,
        message_id: pending.messageId,
        disable_web_page_preview: true,
        ...strategyKeyboard(),
      }).catch(() => bot.sendMessage(chatId, stripHtml(strategyMenuText()), strategyKeyboard()));
    } else {
      await bot.sendMessage(chatId, stripHtml(strategyMenuText()), strategyKeyboard());
    }
  } else {
    setSetting(pending.key, String(value));
    if (pending.messageId) {
      await bot.editMessageText(stripHtml(filtersText()), {
        chat_id: chatId,
        message_id: pending.messageId,
        disable_web_page_preview: true,
        ...filtersKeyboard(),
      }).catch(() => bot.sendMessage(chatId, stripHtml(filtersText()), filtersKeyboard()));
    } else {
      await bot.sendMessage(chatId, stripHtml(filtersText()), filtersKeyboard());
    }
  }
  return true;
}

async function editMenuMessage(query, text, extra = {}) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  const messageId = query.message?.message_id;
  const safeText = stripHtml(text);
  if (!messageId) {
    return bot.sendMessage(chatId, safeText, {
      disable_web_page_preview: true,
      ...extra,
    });
  }
  try {
    return await bot.editMessageText(safeText, {
      chat_id: chatId,
      message_id: messageId,
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (err) {
    if (/message is not modified/i.test(err.message)) return null;
    return bot.sendMessage(chatId, safeText, {
      disable_web_page_preview: true,
      ...extra,
    });
  }
}
