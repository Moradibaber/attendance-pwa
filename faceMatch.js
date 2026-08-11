/* ======================================================
   face-api.js Face Matching Module
   ====================================================== */

const MODEL_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';
let modelsLoaded = false;

async function loadFaceModels() {
  if (modelsLoaded) return true;
  try {
    await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    modelsLoaded = true;
    console.log('face-api models loaded');
    return true;
  } catch (err) {
    console.error('Failed to load face-api models:', err);
    return false;
  }
}

async function getFaceDescriptor(input) {
  try {
    if (!modelsLoaded) {
      const ok = await loadFaceModels();
      if (!ok) return null;
    }

    let img;
    if (typeof input === 'string') {
      img = await faceapi.fetchImage(input);
    } else {
      img = input;
    }

    const detection = await faceapi
      .detectSingleFace(img)
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection) {
      console.log('No face detected');
      return null;
    }

    return detection.descriptor;
  } catch (err) {
    console.error('getFaceDescriptor error:', err);
    return null;
  }
}

function compareFaces(descriptor1, descriptor2) {
  if (!descriptor1 || !descriptor2) return 999;
  return faceapi.euclideanDistance(descriptor1, descriptor2);
}
