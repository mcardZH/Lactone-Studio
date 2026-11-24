'use strict';

function splitImageResult(result) {
  const preview = result?.imagePreview;
  if (preview?.mimeType !== 'image/png' || typeof preview.data !== 'string' || !preview.data.startsWith('iVBORw0KGgo')) {
    return { result };
  }
  const { data, ...metadata } = preview;
  return {
    result: { ...result, imagePreview: metadata },
    image: { mimeType: 'image/png', data },
  };
}

function toolImageUrl(image) {
  return `data:${image.mimeType};base64,${image.data}`;
}

module.exports = { splitImageResult, toolImageUrl };
