// src/config/settings.js
export const settings = {
  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  cookieKey: 'cookies-mercadolivre',

  // Deduplicação
  dedupePrefix: 'ml:postado:',
  dedupeTTL: 86400, // 24h em segundos

  // Coleta
  pageSize: 17,           // tamanho fixo do retorno do hub
  maxPagesPerFonte: 50,   // máximo de páginas por fonte (850 produtos)
  delayBetweenPages: 900, // ms entre páginas
  delayBetweenFontes: 1500,

  // Afiliado
  afiliadoTag: process.env.AFILIADO_TAG || 'co20251022064125',
  afiliadoLoteSize: 30,   // máximo por chamada ao /createLink
  afiliadoDelay: 1200,    // ms entre lotes

  // Endpoint hub
  hubUrl: 'https://www.mercadolivre.com.br/affiliate-program/api/hub/search?is_affiliate=true&device=desktop',
  linkbuilderUrl: 'https://www.mercadolivre.com.br/afiliados/linkbuilder',
  createLinkUrl: 'https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink',

  // Template de imagem
  pictureTemplate: 'https://http2.mlstatic.com/D_Q_NP_2X_{id}-AB.webp',

  // Categorias da Central de Afiliados (extraídas do JSON real)
  categorias: [
    { id: 'MLB5672',  nome: 'Acessórios para Veículos' },
    { id: 'MLB1574',  nome: 'Casa, Móveis e Decoração' },
    { id: 'MLB263532',nome: 'Ferramentas' },
    { id: 'MLB5726',  nome: 'Eletrodomésticos' },
    { id: 'MLB1430',  nome: 'Calçados, Roupas e Bolsas' },
    { id: 'MLB1500',  nome: 'Construção' },
    { id: 'MLB1276',  nome: 'Esportes e Fitness' },
    { id: 'MLB1368',  nome: 'Arte, Papelaria e Armarinho' },
    { id: 'MLB1648',  nome: 'Informática' },
    { id: 'MLB1499',  nome: 'Indústria e Comércio' },
    { id: 'MLB1000',  nome: 'Eletrônicos, Áudio e Vídeo' },
    { id: 'MLB1182',  nome: 'Instrumentos Musicais' },
    { id: 'MLB1246',  nome: 'Beleza e Cuidado Pessoal' },
    { id: 'MLB264586',nome: 'Saúde' },
    { id: 'MLB12404', nome: 'Festas e Lembrancinhas' },
    { id: 'MLB3937',  nome: 'Joias e Relógios' },
    { id: 'MLB1384',  nome: 'Bebês' },
    { id: 'MLB1071',  nome: 'Pet Shop' },
    { id: 'MLB1132',  nome: 'Brinquedos e Hobbies' },
    { id: 'MLB1051',  nome: 'Celulares e Telefones' },
  ],
};
