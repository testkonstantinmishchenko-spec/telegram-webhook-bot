const express = require('express');
const bodyParser = require('body-parser');

// Замените эти значения на свои!
const TELEGRAM_BOT_TOKEN = '7258788827:AAHLAZK1vdJOGj_6AAqE9W6B5vUd7mUUJ_4';
const TELEGRAM_CHAT_ID = '-1003330015301'; // Можно сделать массивом, если нужно слать в несколько чатов

const app = express();
const port = process.env.PORT || 3000; // Порт, который будет использовать сервер

// Используем body-parser, чтобы читать JSON из тела запроса
app.use(bodyParser.json());

// Главный эндпоинт (URL), на который ваш сайт будет отправлять вебхуки
app.post('/webhook', (req, res) => {
    console.log('Получен вебхук:', req.body); // Для отладки

    // Извлекаем нужные данные из тела запроса (req.body)
    // ВАЖНО: Названия полей (order_id, amount, customer_name) нужно заменить на те,
    // которые приходят в вашем вебхуке. Посмотрите их в консоли или на Webhook.site
    const orderId = req.body.order_id || req.body.id || 'Не указан';
    const amount = req.body.amount || req.body.price || 'Не указана';
    const customerName = req.body.customer_name || req.body.name || 'Не указан';

    // Формируем текст сообщения для Telegram
    const message = `
🔔 Новое событие на сайте!
ID заказа: ${orderId}
Сумма: ${amount} руб.
Клиент: ${customerName}
    `;

    // Формируем URL для отправки сообщения через Telegram Bot API
    const telegramApiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    // Опции для HTTP-запроса к Telegram
    const fetchOptions = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML', // Опционально: можно использовать HTML для форматирования
        }),
    };

    // Отправляем запрос в Telegram
    // Используем fetch (доступен в Node.js 18+). Для старых версий нужно установить node-fetch
    fetch(telegramApiUrl, fetchOptions)
        .then(telegramResponse => {
            if (!telegramResponse.ok) {
                // Если Telegram вернул ошибку, логируем её
                return telegramResponse.text().then(text => {
                    throw new Error(`Telegram API error: ${telegramResponse.status} ${text}`);
                });
            }
            return telegramResponse.json();
        })
        .then(data => {
            console.log('Сообщение в Telegram отправлено:', data);
            // Отвечаем сайту, что всё хорошо (статус 200)
            res.status(200).send('OK');
        })
        .catch(error => {
            console.error('Ошибка при отправке в Telegram:', error);
            // Отвечаем сайту, что произошла ошибка (статус 500)
            res.status(500).send('Error');
        });
});

// Запускаем сервер
app.listen(port, () => {
    console.log(`Бот слушает вебхуки на порту ${port}`);
});