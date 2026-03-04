const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// ---- 1. Настройка базы данных SQLite ----
const dbPath = process.env.DB_PATH || path.join(__dirname, 'stats.db');
const db = new sqlite3.Database(dbPath);

// Таблица для подробных закрытий (старый формат)
db.run(`
    CREATE TABLE IF NOT EXISTS closes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operator_email TEXT NOT NULL,
        dialog_number INTEGER,
        conversation_id TEXT NOT NULL,
        closed_at TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`);

// Таблица для событий нового чата (назначения и короткие закрытия)
db.run(`
    CREATE TABLE IF NOT EXISTS chat_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,          -- 'assigned' или 'closed_short'
        operator_name TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,          -- время события в UTC
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`);

// ---- 2. Функция форматирования времени (МСК) ----
function formatToMoscowTime(utcString) {
    const date = new Date(utcString);
    const moscowTime = new Date(date.getTime() + 3 * 60 * 60 * 1000);
    
    const day = String(moscowTime.getUTCDate()).padStart(2, '0');
    const month = String(moscowTime.getUTCMonth() + 1).padStart(2, '0');
    const year = moscowTime.getUTCFullYear();
    const hours = String(moscowTime.getUTCHours()).padStart(2, '0');
    const minutes = String(moscowTime.getUTCMinutes()).padStart(2, '0');
    const seconds = String(moscowTime.getUTCSeconds()).padStart(2, '0');
    
    return { date: `${day}.${month}.${year}`, time: `${hours}:${minutes}:${seconds}` };
}

// ---- 3. Универсальная функция отправки сообщения в Telegram ----
async function sendTelegramMessage(chatId, text, options = {}) {
    // Значение по умолчанию (токен из исходного кода)
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '7258788827:AAHLAZK1vdJOGj_6AAqE9W6B5vUd7mUUJ_4';
    const url = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
    const payload = {
        chat_id: chatId,
        text: text,
        ...options
    };
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.error('Ошибка отправки в Telegram:', e);
    }
}

// ---- 4. Эндпоинт для вебхуков ----
app.post('/webhook', async (req, res) => {
    try {
        console.log('Получен вебхук:', JSON.stringify(req.body, null, 2));

        const payload = req.body;
        const event = payload.event;
        const data = payload.data || {};
        const timestamp = payload.timestamp;

        // --- Обработка chat.assigned ---
        if (event === 'chat.assigned') {
            const { operator_name, conversation_id } = data;
            if (!operator_name || !conversation_id || !timestamp) {
                console.error('Неполные данные для chat.assigned');
                return res.status(200).send('Missing data');
            }

            // Сохраняем в таблицу chat_events
            db.run(
                `INSERT INTO chat_events (event_type, operator_name, conversation_id, occurred_at) VALUES (?, ?, ?, ?)`,
                ['assigned', operator_name, conversation_id, timestamp],
                function(err) {
                    if (err) console.error('Ошибка сохранения назначения:', err);
                }
            );

            const { date, time } = formatToMoscowTime(timestamp);
            const message = `${operator_name} ${conversation_id} назначен ${date} ${time}`;
            // ID нового чата (значение по умолчанию)
            const assignedChatId = process.env.ASSIGNED_CHAT_ID || '-1003699948179';
            await sendTelegramMessage(assignedChatId, message);
            console.log('Уведомление о назначении отправлено');
            return res.status(200).send('OK');
        }

        // --- Обработка chat.closed (два формата) ---
        if (event === 'chat.closed') {
            const isDetailed = data.conversation && data.operator && data.close_info;

            if (isDetailed) {
                // Подробный формат (старый)
                const conversation = data.conversation;
                const operator = data.operator;
                const closeInfo = data.close_info;

                if (!conversation || !operator || !closeInfo) {
                    console.error('Отсутствуют необходимые данные в подробном закрытии');
                    return res.status(200).send('Missing data');
                }

                const dialogNumber = conversation.dialog_number;
                const conversationId = conversation.id;
                const operatorEmail = operator.email;
                const closedAtUTC = conversation.closed_at;

                // Сохраняем в БД closes
                db.run(
                    `INSERT INTO closes (operator_email, dialog_number, conversation_id, closed_at) VALUES (?, ?, ?, ?)`,
                    [operatorEmail, dialogNumber, conversationId, closedAtUTC],
                    function(err) {
                        if (err) console.error('Ошибка сохранения в БД:', err);
                    }
                );

                const { date, time } = formatToMoscowTime(closedAtUTC);
                const chatLink = `https://chat.moneyman.ru/operator/chat/${conversationId}`;
                const messageHtml = `<a href="${chatLink}">№${dialogNumber}</a> ${operatorEmail} закрыт ${date} ${time}`;
                const notifyChatId = process.env.NOTIFY_CHAT_ID || '-1003330015301';
                await sendTelegramMessage(notifyChatId, messageHtml, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
                console.log('Уведомление о закрытии (подробное) отправлено');
                return res.status(200).send('OK');
            } else {
                // Короткий формат (новый)
                const { operator_name, conversation_id } = data;
                if (!operator_name || !conversation_id || !timestamp) {
                    console.error('Неполные данные для короткого закрытия');
                    return res.status(200).send('Missing data');
                }

                // Сохраняем в таблицу chat_events
                db.run(
                    `INSERT INTO chat_events (event_type, operator_name, conversation_id, occurred_at) VALUES (?, ?, ?, ?)`,
                    ['closed_short', operator_name, conversation_id, timestamp],
                    function(err) {
                        if (err) console.error('Ошибка сохранения короткого закрытия:', err);
                    }
                );

                const { date, time } = formatToMoscowTime(timestamp);
                const message = `${operator_name} ${conversation_id} закрыт ${date} ${time}`;
                const assignedChatId = process.env.ASSIGNED_CHAT_ID || '-5215568998';
                await sendTelegramMessage(assignedChatId, message);
                console.log('Уведомление о закрытии (короткое) отправлено');
                return res.status(200).send('OK');
            }
        }

        console.log('Событие проигнорировано:', event);
        res.status(200).send('Ignored');
    } catch (error) {
        console.error('Ошибка при обработке:', error);
        res.status(200).send('Error logged');
    }
});

// ---- 5. Эндпоинт для команд Telegram ----
app.post('/telegram-webhook', async (req, res) => {
    try {
        const update = req.body;
        console.log('Получено обновление от Telegram:', JSON.stringify(update));

        if (!update.message) {
            return res.status(200).send('OK');
        }

        const chatId = update.message.chat.id;
        const text = update.message.text || '';

        // ID чатов (значения по умолчанию)
        const notifyChatId = process.env.NOTIFY_CHAT_ID || '-1003330015301';
        const assignedChatId = process.env.ASSIGNED_CHAT_ID || '-5215568998';
        const adminId = parseInt(process.env.ADMIN_ID || '241380306', 10);

        // Команда /stats
        if (text === '/stats') {
            if (chatId.toString() === notifyChatId) {
                // Старый чат — статистика из таблицы closes
                db.all(
                    `SELECT operator_email, COUNT(*) as count FROM closes GROUP BY operator_email ORDER BY count DESC`,
                    [],
                    (err, rows) => {
                        if (err) {
                            console.error('Ошибка получения статистики (closes):', err);
                            sendTelegramMessage(chatId, '❌ Ошибка при получении статистики.');
                            return;
                        }

                        if (rows.length === 0) {
                            sendTelegramMessage(chatId, '📊 Статистика по закрытиям пуста.');
                            return;
                        }

                        let message = '📊 *Статистика закрытых чатов (подробные):*\n\n';
                        rows.forEach((row, index) => {
                            message += `${index + 1}. ${row.operator_email} — *${row.count}*\n`;
                        });

                        sendTelegramMessage(chatId, message, { parse_mode: 'Markdown' });
                    }
                );
            } else if (chatId.toString() === assignedChatId) {
                // Новый чат — статистика из chat_events по типам
                db.all(
                    `SELECT event_type, operator_name, COUNT(*) as count 
                     FROM chat_events 
                     GROUP BY event_type, operator_name 
                     ORDER BY event_type, count DESC`,
                    [],
                    (err, rows) => {
                        if (err) {
                            console.error('Ошибка получения статистики (chat_events):', err);
                            sendTelegramMessage(chatId, '❌ Ошибка при получении статистики.');
                            return;
                        }

                        if (rows.length === 0) {
                            sendTelegramMessage(chatId, '📊 Статистика по новому чату пуста.');
                            return;
                        }

                        let assignedMsg = '📊 *Назначения:*\n';
                        let closedMsg = '📊 *Закрытия (короткие):*\n';
                        let hasAssigned = false, hasClosed = false;

                        rows.forEach((row, index) => {
                            if (row.event_type === 'assigned') {
                                assignedMsg += `${index + 1}. ${row.operator_name} — *${row.count}*\n`;
                                hasAssigned = true;
                            } else if (row.event_type === 'closed_short') {
                                closedMsg += `${index + 1}. ${row.operator_name} — *${row.count}*\n`;
                                hasClosed = true;
                            }
                        });

                        let finalMessage = '';
                        if (hasAssigned) finalMessage += assignedMsg + '\n';
                        if (hasClosed) finalMessage += closedMsg;

                        sendTelegramMessage(chatId, finalMessage, { parse_mode: 'Markdown' });
                    }
                );
            } else {
                sendTelegramMessage(chatId, '❌ Команда /stats доступна только в специальных чатах.');
            }
            return res.status(200).send('OK');
        }

        // Команда /clear_stats (только для админа, очищает обе таблицы)
        if (text === '/clear_stats') {
            if (chatId !== adminId) {
                sendTelegramMessage(chatId, '⛔ Недостаточно прав для очистки статистики.');
                return res.status(200).send('OK');
            }

            db.serialize(() => {
                db.run("DELETE FROM closes", function(err) {
                    if (err) console.error('Ошибка очистки closes:', err);
                });
                db.run("DELETE FROM chat_events", function(err) {
                    if (err) console.error('Ошибка очистки chat_events:', err);
                });
            });

            sendTelegramMessage(chatId, '✅ Статистика полностью очищена (обе таблицы).');
            return res.status(200).send('OK');
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('Ошибка обработки команды Telegram:', error);
        res.status(200).send('OK');
    }
});

// ---- 6. Запуск сервера и установка вебхука Telegram ----
app.listen(port, async () => {
    console.log(`Бот слушает вебхуки на порту ${port}`);

    const publicUrl = process.env.PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN;
    if (!publicUrl) {
        console.warn('PUBLIC_URL не задан, вебхук Telegram не будет установлен автоматически. Установите его вручную или задайте PUBLIC_URL.');
        return;
    }

    const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '7258788827:AAHLAZK1vdJOGj_6AAqE9W6B5vUd7mUUJ_4';
    const webhookUrl = `https://${publicUrl}/telegram-webhook`;
    const setWebhookUrl = `https://api.telegram.org/bot${telegramToken}/setWebhook?url=${webhookUrl}`;

    try {
        const response = await fetch(setWebhookUrl);
        const result = await response.json();
        if (result.ok) {
            console.log('Вебхук для Telegram успешно установлен:', webhookUrl);
        } else {
            console.error('Ошибка установки вебхука Telegram:', result);
        }
    } catch (error) {
        console.error('Не удалось установить вебхук Telegram:', error);
    }
});