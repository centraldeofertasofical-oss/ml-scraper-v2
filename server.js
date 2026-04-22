require('dotenv').config();
const express = require('express');
const { settings } = require('./src/config/settings');
const { log } = require('./src/utils/logger');

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.use('/status', require('./src/routes/status'));
app.use('/coletar', require('./src/routes/coletar'));

app.listen(settings.PORT, () => {
  log(`ml-scraper-v2 rodando na porta ${settings.PORT}`);
  log(`Status: http://localhost:${settings.PORT}/status`);
});