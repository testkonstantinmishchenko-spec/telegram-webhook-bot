const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Парсинг JSON
app.use(express.json());

// ---- 1. Настройка базы данных SQLite ----
// Для Railway: если примонтирован volume к /data, база будет сохраняться между перезапусками
const dbPath = process.env.DB_PATH || path.join(__dirname, 'stats.db');
const db = new sqlite3.Database(dbPath);

// Создаём таблицу, если её нет
db.run(`
    CREATE TABLE IF NOT EXISTS closes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operator_email TEXT NOT NULL,
        dialog_number INTEGER NOT NULL,
        conversation_id TEXT NOT NULL,
        closed_at TEXT NOT NULL,
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
    
    return `${day}.${month}.${year} ${hours}:${minutes}`;
}

// ---- 3. Эндпоинт для вебхуков от вашего сайта (закрытие чата) ----
app.post('/webhook', async (req, res) => {
    try {
        console.log('Получен вебхук:', JSON.stringify(req.body, null, 2));

        const payload = req.body;
        const event = payload.event;
        
        // Нас интересует только chat.closed
        if (event !== 'chat.closed') {
            return res.status(200).send('Ignored');
        }

        const data = payload.data;
        const conversation = data.conversation;
        const operator = data.operator;
        const closeInfo = data.close_info;

        if (!conversation || !operator || !closeInfo) {
            console.error('Отсутствуют необходимые данные');
            return res.status(200).send('Missing data');
        }

        const dialogNumber = conversation.dialog_number;
        const conversationId = conversation.id;
        const operatorEmail = operator.email;
        const closedAtUTC = conversation.closed_at;

        // Сохраняем запись в базу данных
        db.run(
            `INSERT INTO closes (operator_email, dialog_number, conversation_id, closed_at) VALUES (?, ?, ?, ?)`,
            [operatorEmail, dialogNumber, conversationId, closedAtUTC],
            function(err) {
                if (err) {
                    console.error('Ошибка сохранения в БД:', err);
                } else {
                    console.log(`Сохранена запись для диалога №${dialogNumber}`);
                }
            }
        );

        // Отправляем уведомление в Telegram
        const closedAtMoscow = formatToMoscowTime(closedAtUTC);
        const chatLink = `https://chat.moneyman.ru/operator/chat/${conversationId}`;
        const messageHtml = `<a href="${chatLink}">№${dialogNumber}</a> ${operatorEmail} закрыт ${closedAtMoscow}`;

        const telegramToken = '7258788827:AAHLAZK1vdJOGj_6AAqE9W6B5vUd7mUUJ_4';   // ваш токен
        const notifyChatId = '-1003330015301';            // ID чата для уведомлений
        const telegramUrl = `https://api.telegram.org/bot${telegramToken}/sendMessage`;

        await fetch(telegramUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: notifyChatId,
                text: messageHtml,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            })
        });

        console.log('Сообщение отправлено в Telegram');
        res.status(200).send('OK');
    } catch (error) {
        console.error('Ошибка при обработке:', error);
        res.status(200).send('Error logged');
    }
});

// ---- 4. Эндпоинт для приёма команд от Telegram (вебхук) ----
app.post('/telegram-webhook', async (req, res) => {
    try {
        const update = req.body;
        console.log('Получено обновление от Telegram:', JSON.stringify(update));

        if (!update.message) {
            return res.status(200).send('OK');
        }

        const chatId = update.message.chat.id;
        const text = update.message.text || '';

        // Если команда /stats
        if (text === '/stats') {
            // Получаем статистику из БД
            db.all(
                `SELECT operator_email, COUNT(*) as count FROM closes GROUP BY operator_email ORDER BY count DESC`,
                [],
                (err, rows) => {
                    if (err) {
                        console.error('Ошибка получения статистики:', err);
                        sendTelegramMessage(chatId, '❌ Ошибка при получении статистики.');
                        return;
                    }

                    if (rows.length === 0) {
                        sendTelegramMessage(chatId, '📊 Статистика пуста.');
                        return;
                    }

                    // Формируем сообщение
                    let message = '📊 *Статистика закрытых чатов по операторам:*\n\n';
                    rows.forEach((row, index) => {
                        message += `${index + 1}. ${row.operator_email} — *${row.count}*\n`;
                    });

                    sendTelegramMessage(chatId, message, { parse_mode: 'Markdown' });
                }
            );
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('Ошибка обработки команды Telegram:', error);
        res.status(200).send('OK');
    }
});

// Вспомогательная функция для отправки сообщений в Telegram
async function sendTelegramMessage(chatId, text, options = {}) {
    const telegramToken = '7258788827:AAHLAZK1vdJOGj_6AAqE9W6B5vUd7mUUJ_4';
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

// ---- 5. Запуск сервера и установка вебхука Telegram ----
app.listen(port, async () => {
    console.log(`Бот слушает вебхуки на порту ${port}`);

    // Устанавливаем вебхук для Telegram (можно сделать один раз вручную)
    const telegramToken = '7258788827:AAHLAZK1vdJOGj_6AAqE9W6B5vUd7mUUJ_4';
    const webhookUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'your-domain.com'}/telegram-webhook`;
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