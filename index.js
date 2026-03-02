const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Чтобы парсить JSON в теле запроса
app.use(express.json());

// Функция для преобразования UTC в московское время и форматирования
function formatToMoscowTime(utcString) {
    const date = new Date(utcString);
    // Московское время = UTC+3
    const moscowTime = new Date(date.getTime() + 3 * 60 * 60 * 1000);
    
    const day = String(moscowTime.getUTCDate()).padStart(2, '0');
    const month = String(moscowTime.getUTCMonth() + 1).padStart(2, '0');
    const year = moscowTime.getUTCFullYear();
    const hours = String(moscowTime.getUTCHours()).padStart(2, '0');
    const minutes = String(moscowTime.getUTCMinutes()).padStart(2, '0');
    
    return `${day}.${month}.${year} ${hours}:${minutes}`;
}

// Эндпоинт для вебхуков
app.post('/webhook', async (req, res) => {
    try {
        console.log('Получен вебхук:', JSON.stringify(req.body, null, 2));

        // Извлекаем данные
        const payload = req.body;
        const event = payload.event;
        
        // Нас интересует только событие chat.closed
        if (event !== 'chat.closed') {
            return res.status(200).send('Ignored');
        }

        const data = payload.data;
        const conversation = data.conversation;
        const operator = data.operator;
        const closeInfo = data.close_info;

        // Проверяем, что все нужные поля есть
        if (!conversation || !operator || !closeInfo) {
            console.error('Отсутствуют необходимые данные');
            return res.status(200).send('Missing data'); // всё равно 200, чтобы сайт не мучал повторными отправками
        }

        const dialogNumber = conversation.dialog_number;
        const operatorEmail = operator.email || 'email не указан';
        const closedAtUTC = conversation.closed_at;

        // Преобразуем время
        const closedAtMoscow = formatToMoscowTime(closedAtUTC);

        // Формируем сообщение
        const message = `№${dialogNumber} ${operatorEmail} закрыт ${closedAtMoscow}`;

        // Отправляем в Telegram
        const telegramToken = '7258788827:AAHLAZK1vdJOGj_6AAqE9W6B5vUd7mUUJ_4';   // замените
        const chatId = '-1003330015301';            // замените
        const telegramUrl = `https://api.telegram.org/bot${telegramToken}/sendMessage`;

        const telegramResponse = await fetch(telegramUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
            }),
        });

        if (!telegramResponse.ok) {
            const errorText = await telegramResponse.text();
            throw new Error(`Telegram API error: ${telegramResponse.status} ${errorText}`);
        }

        console.log('Сообщение отправлено в Telegram');
        res.status(200).send('OK');
    } catch (error) {
        console.error('Ошибка при обработке:', error);
        // Всё равно отвечаем 200, чтобы сайт не пытался переотправить
        res.status(200).send('Error logged');
    }
});

app.listen(port, () => {
    console.log(`Бот слушает вебхуки на порту ${port}`);
});