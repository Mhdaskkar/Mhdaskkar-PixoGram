/**
 * Azure Cognitive Services — Computer Vision
 * Used for: auto-tagging, content moderation (adult/racy detection)
 */
const { ComputerVisionClient } = require('@azure/cognitiveservices-computervision');
const { ApiKeyCredentials }    = require('@azure/ms-rest-azure-js');

const VISION_KEY      = process.env.AZURE_VISION_KEY;
const VISION_ENDPOINT = process.env.AZURE_VISION_ENDPOINT || 'https://PixoGram-vision.cognitiveservices.azure.com/';

let _client;

function getClient() {
  if (!_client) {
    _client = new ComputerVisionClient(
      new ApiKeyCredentials({ inHeader: { 'Ocp-Apim-Subscription-Key': VISION_KEY } }),
      VISION_ENDPOINT
    );
  }
  return _client;
}

/**
 * Analyze an image by URL
 * Returns: { tags, adult, description }
 */
async function analyzeImage(imageUrl) {
  const client = getClient();

  const result = await client.analyzeImage(imageUrl, {
    visualFeatures: ['Tags', 'Adult', 'Description'],
    language: 'en',
  });

  return {
    tags: (result.tags || []).filter(t => t.confidence > 0.7),
    adult: result.adult,
    description: result.description?.captions?.[0]?.text,
  };
}

/**
 * Analyze image from buffer (upload via stream)
 */
async function analyzeImageBuffer(buffer) {
  const client = getClient();
  const { Readable } = require('stream');
  const stream = Readable.from(buffer);

  const result = await client.analyzeImageInStream(stream, {
    visualFeatures: ['Tags', 'Adult'],
    language: 'en',
  });

  return {
    tags: (result.tags || []).filter(t => t.confidence > 0.7).map(t => ({ name: t.name, confidence: t.confidence })),
    adult: result.adult,
    isModerated: result.adult?.isAdultContent || result.adult?.isRacyContent,
  };
}

module.exports = { analyzeImage, analyzeImageBuffer };