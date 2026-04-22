const settings = {
  PORT: process.env.PORT || 3001,
  REDIS_URL: process.env.REDIS_URL,
  AFILIADO_TAG: process.env.AFILIADO_TAG || 'co20251022064125',
  LIMITE_POR_EXECUCAO: parseInt(process.env.LIMITE_POR_EXECUCAO || '166'),
  LOTE_AFILIADO: parseInt(process.env.LOTE_AFILIADO || '30'),
  DEDUPE_TTL_HORAS: parseInt(process.env.DEDUPE_TTL_HORAS || '24'),
  PAGE_SIZE: 17,
  MAX_PAGES_POR_FONTE: 50,
};

const FILTROS_GLOBAIS = {
  PRECO_MIN: 20,
  DESCONTO_MIN: 15,
  EXIGE_IMAGEM: true,
};

// IDs reais confirmados na API do hub ML
const PERFIS = [
  {
    id: 1,
    nome: 'Top Comissão',
    categorias_extra: [],
    filtros: { comissao_min: 20, desconto_min: 15 },
  },
  {
    id: 2,
    nome: 'Moda & Beleza',
    categorias_extra: ['MLB1430', 'MLB1246'],
    filtros: { comissao_min: 0, desconto_min: 25 },
  },
  {
    id: 3,
    nome: 'Tech & Eletro',
    categorias_extra: ['MLB1051', 'MLB1000', 'MLB1648', 'MLB5726'],
    filtros: { comissao_min: 0, desconto_min: 20 },
  },
  {
    id: 4,
    nome: 'Casa & Família',
    categorias_extra: ['MLB1574', 'MLB1071', 'MLB1384'],
    filtros: { comissao_min: 0, desconto_min: 15 },
  },
  {
    id: 5,
    nome: 'Esporte & Saúde',
    categorias_extra: ['MLB1276', 'MLB264586'],
    filtros: { comissao_min: 0, desconto_min: 30 },
  },
  {
    id: 6,
    nome: 'Alto Desconto',
    categorias_extra: [],
    filtros: { comissao_min: 0, desconto_min: 40 },
  },
  {
    id: 7,
    nome: 'Mix Equilibrado',
    categorias_extra: ['MLB1430', 'MLB1000', 'MLB1574', 'MLB1276', 'MLB1246'],
    filtros: { comissao_min: 0, desconto_min: 20 },
  },
];

module.exports = { settings, FILTROS_GLOBAIS, PERFIS };