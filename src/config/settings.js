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

const PERFIS = [
  { id:1, nome:'Top Comissão',    fontes:['GANHOS_EXTRAS'], categorias_extra:[], filtros:{ comissao_min:20, desconto_min:15 } },
  { id:2, nome:'Moda & Beleza',   fontes:['GANHOS_EXTRAS'], categorias_extra:['fashion_women','fashion_men','shoes','beauty'], filtros:{ comissao_min:0, desconto_min:25 } },
  { id:3, nome:'Tech & Eletro',   fontes:['GANHOS_EXTRAS'], categorias_extra:['cellphones','electronics','computing','home_appliances'], filtros:{ comissao_min:0, desconto_min:20 } },
  { id:4, nome:'Casa & Família',  fontes:['GANHOS_EXTRAS'], categorias_extra:['home_decor','kitchen','baby','pets'], filtros:{ comissao_min:0, desconto_min:15 } },
  { id:5, nome:'Esporte & Fitness', fontes:['GANHOS_EXTRAS'], categorias_extra:['sports','fitness'], filtros:{ comissao_min:0, desconto_min:30 } },
  { id:6, nome:'Alto Desconto',   fontes:['GANHOS_EXTRAS'], categorias_extra:[], filtros:{ comissao_min:0, desconto_min:40 } },
  { id:7, nome:'Mix Equilibrado', fontes:['GANHOS_EXTRAS'], categorias_extra:['fashion_women','fashion_men','electronics','home_decor','sports','beauty'], filtros:{ comissao_min:0, desconto_min:20 } },
];

module.exports = { settings, FILTROS_GLOBAIS, PERFIS };