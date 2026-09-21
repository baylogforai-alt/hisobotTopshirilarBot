'use strict';

/**
 * Handlerlar uchun umumiy yordamchilar (v1 da 3 faylda takrorlanardi).
 *
 *  render(ctx, text, keyboard) — tugma bosilgan bo'lsa o'sha xabarni yangilaydi
 *                                (chat toza qoladi, "ilova"dek), aks holda yangi
 *                                xabar yuboradi. Uzun matn bo'laklarga bo'linadi.
 *  guard(ctx)                  — faqat admin; bo'lmasa xushmuomala rad javobi.
 *  splitText(text)             — 4096 chegarasiga sig'adigan bo'laklar (<pre> buzilmaydi).
 */

const TG_LIMIT = 3800;

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

/** Telegram chegarasiga sig'adigan bo'laklarga bo'ladi — <pre> bloklari buzilmaydi */
const splitText = (text, limit = TG_LIMIT) => {
  if (text.length <= limit) return [text];
  const parts = [];
  let buf = '';
  let open = 0;
  for (const line of text.split('\n')) {
    open += (line.match(/<pre>/g) || []).length;
    open -= (line.match(/<\/pre>/g) || []).length;
    if (buf.length + line.length + 1 > limit && open === 0 && buf) {
      parts.push(buf);
      buf = '';
    }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) parts.push(buf);
  return parts;
};

const isNotModified = (err) => /message is not modified/i.test((err && (err.description || err.message)) || '');

const render = async (ctx, text, keyboard) => {
  const extra = { ...HTML, ...(keyboard || {}) };
  const parts = splitText(text);

  if (parts.length === 1 && ctx.updateType === 'callback_query') {
    try {
      return await ctx.editMessageText(parts[0], extra);
    } catch (err) {
      if (isNotModified(err)) return null;
      return ctx.reply(parts[0], extra);
    }
  }
  let last = null;
  for (let i = 0; i < parts.length; i += 1) {
    const isLast = i === parts.length - 1;
    last = await ctx.reply(parts[i], isLast ? extra : HTML);
  }
  return last;
};

/** Faqat administrator uchun */
const guard = async (ctx) => {
  if (ctx.state.isAdmin) return true;
  if (ctx.updateType === 'callback_query') await ctx.answerCbQuery('⛔️ Faqat administrator uchun');
  else await ctx.reply("⛔️ Bu bo'lim faqat administrator uchun.");
  return false;
};

/** Buyruq argumentlari: '/hodim_qosh 123 Akbar' → '123 Akbar' */
const args = (ctx) => String((ctx.message && ctx.message.text) || '').replace(/^\/\S+\s*/, '').trim();

module.exports = { render, guard, splitText, args, HTML, TG_LIMIT };
