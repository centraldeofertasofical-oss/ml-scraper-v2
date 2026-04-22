// src/utils/parser.js
import { settings } from '../config/settings.js';

// Monta a URL completa do produto com parâmetros de afiliado
function buildUrl(meta) {
  const base = meta.url || '';
  const fragments = meta.url_fragments || '';
  const params = meta.url_params || '';

  // url já pode vir com ou sem https://
  const fullBase = base.startsWith('http') ? base : `https://${base}`;
  return `${fullBase}${params}${fragments}`;
}

// Monta URL da imagem usando o template do ML
function buildImageUrl(pictures) {
  const picId = pictures?.pictures?.[0]?.id;
  if (!picId) return null;
  return settings.pictureTemplate.replace('{id}', picId);
}

// Extrai componente por tipo e id
function getComponent(components = [], id) {
  return components.find(c => c.id === id);
}

// Extrai % de comissão do chip (ex: "28%" → 28)
function parseComissao(chip) {
  if (!chip?.chip?.label?.text) return null;
  const match = String(chip.chip.label.text).match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

// Parser principal de um polycard
export function parsePolycard(card, fonte = 'HUB') {
  if (!card?.metadata || !card?.components) return null;

  const meta = card.metadata;
  const components = card.components;

  // Título
  const titleComp = getComponent(components, 'title');
  const titulo = titleComp?.title?.text?.trim() || null;
  if (!titulo) return null;

  // Preço
  const priceComp = getComponent(components, 'price');
  const priceData = priceComp?.price || {};
  const precoPor = priceData.current_price?.value || null;
  const precoDe = priceData.previous_price?.value || null;
  const descontoPct = priceData.discount?.value || null;

  if (!precoPor || precoPor <= 0) return null;

  // Comissão
  const chipComp = getComponent(components, 'affiliates_commission_chip');
  const comissaoPct = parseComissao(chipComp);

  // Highlight (MAIS VENDIDO, etc)
  const highlightComp = getComponent(components, 'highlight');
  const highlight = highlightComp?.highlight?.text || null;

  // Imagem
  const imagemUrl = buildImageUrl(card.pictures);

  // Link original (sem fragmentos de afiliado — para usar no /createLink)
  const metaUrl = meta.url || '';
  const linkOriginal = metaUrl.startsWith('http') ? metaUrl : `https://${metaUrl}`;

  // MLB ID principal
  const mlbId = meta.id || null;
  if (!mlbId) return null;

  // Tipo de produto (product, user_product, item)
  const tipo = meta.type || 'item';

  // Verifica se tem ganho extra
  const ganhoExtra = meta.extra_commission === 'true';

  return {
    ID:             mlbId,
    PRODUCT_ID:     meta.product_id || null,
    USER_PRODUCT_ID:meta.user_product_id || null,

    PLATAFORMA:     'Mercado Livre',
    ORIGEM:         fonte,
    TIPO:           tipo,

    PRODUTO:        titulo,
    LINK_ORIGINAL:  linkOriginal,
    LINK_HUB:       buildUrl(meta),
    LINK_AFILIADO:  null, // preenchido depois

    LINK_IMAGEM:    imagemUrl,

    PRECO_DE:       precoDe,
    PRECO_POR:      precoPor,
    DESCONTO_PCT:   descontoPct,

    COMISSAO_PCT:   comissaoPct,
    GANHO_EXTRA:    ganhoExtra,
    DESTAQUE:       highlight,

    DATA_COLETA:    new Date().toISOString(),
    STATUS:         'NOVO',
  };
}

// Extrai todos os produtos de uma resposta do hub
export function parseHubResponse(data, fonte = 'HUB') {
  const polycards = data?.polycard_client_model?.polycards || [];
  if (!polycards.length) return [];

  const produtos = [];
  for (const card of polycards) {
    const produto = parsePolycard(card, fonte);
    if (produto) produtos.push(produto);
  }
  return produtos;
}
