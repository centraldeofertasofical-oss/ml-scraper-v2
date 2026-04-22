import express from 'express';
import dotenv from 'dotenv';
import coletarRoute from './src/routes/coletar.js';
import statusRoute from './src/routes/status.js';

dotenv.config();

const app = express();
app.use(express.json());

// Health check rápido
app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    servico: 'ml-scraper-v2',
    timestamp: new Date().toISOString(),
  });
});

// Rotas
app.use('/status', statusRoute);
app.use('/coletar', coletarRoute);

// 404
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Rota não encontrada' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[ml-scraper-v2] Rodando na porta ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Status: http://localhost:${PORT}/status`);
});
