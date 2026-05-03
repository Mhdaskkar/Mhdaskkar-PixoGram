/**
 * Azure Computer Vision Service
 * Uses @azure/ai-vision-image-analysis SDK
 */
const createClient = require('@azure-rest/ai-vision-image-analysis').default 
  || require('@azure-rest/ai-vision-image-analysis');
const { AzureKeyCredential } = require('@azure/core-auth');

const VISION_KEY      = process.env.VISION_KEY;
const VISION_ENDPOINT = process.env.VISION_ENDPOINT || 'https://pixogram-vision.cognitiveservices.azure.com/';

let _client;

function getClient() {
  if (!_client) {
    if (!VISION_KEY) throw new Error('VISION_KEY not set');
    _client = createClient(VISION_ENDPOINT, new AzureKeyCredential(VISION_KEY));
  }
  return _client;
}

async function analyzeImage(imageUrl) {
  try {
    const client = getClient();
    const result = await client.path('/imageanalysis:analyze').post({
      body: { url: imageUrl },
      queryParameters: {
        features: ['Caption', 'Tags', 'Adult'],
        language: 'en',
      },
      contentType: 'application/json',
    });

    const body = result.body;

    return {
      description: body.captionResult?.text || null,
      confidence:  body.captionResult?.confidence || 0,
      tags: (body.tagsResult?.values || [])
        .filter(t => t.confidence > 0.7)
        .map(t => ({ name: t.name, confidence: t.confidence })),
      adult: {
        isAdultContent: body.adultResult?.isAdultContent || false,
        isRacyContent:  body.adultResult?.isRacyContent  || false,
        adultScore:     body.adultResult?.adultScore     || 0,
      },
    };
  } catch (err) {
    console.warn('[vision] analyzeImage failed:', err.message);
    return { description: null, tags: [], adult: { isAdultContent: false, isRacyContent: false } };
  }
}

async function analyzeImageBuffer(buffer) {
  try {
    const client = getClient();
    const result = await client.path('/imageanalysis:analyze').post({
      body: buffer,
      queryParameters: {
        features: ['Caption', 'Tags', 'Adult'],
        language: 'en',
      },
      contentType: 'application/octet-stream',
    });

    const body = result.body;

    return {
      description: body.captionResult?.text || null,
      tags: (body.tagsResult?.values || [])
        .filter(t => t.confidence > 0.7)
        .map(t => ({ name: t.name, confidence: t.confidence })),
      adult: {
        isAdultContent: body.adultResult?.isAdultContent || false,
        isRacyContent:  body.adultResult?.isRacyContent  || false,
      },
      isModerated: body.adultResult?.isAdultContent || body.adultResult?.isRacyContent || false,
    };
  } catch (err) {
    console.warn('[vision] analyzeImageBuffer failed:', err.message);
    return { description: null, tags: [], adult: { isAdultContent: false, isRacyContent: false }, isModerated: false };
  }
}

module.exports = { analyzeImage, analyzeImageBuffer };