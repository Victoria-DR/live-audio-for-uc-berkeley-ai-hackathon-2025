/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import {Blob} from '@google/genai';

function encode(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Basic linear resampling function.
 * @param inputData Float32Array of audio data.
 * @param inputSr The sample rate of inputData.
 * @param outputSr The desired output sample rate.
 * @returns Float32Array of resampled audio data.
 */
function resampleLinear(inputData: Float32Array, inputSr: number, outputSr: number): Float32Array {
  if (inputSr === outputSr) {
    return inputData;
  }

  const ratio = inputSr / outputSr;
  const outputLength = Math.floor(inputData.length / ratio);
  const result = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const C1 = i * ratio; 
    const C0 = Math.floor(C1);
    const C2 = Math.min(C0 + 1, inputData.length - 1);
    
    if (C0 < 0 || C0 >= inputData.length) {
        result[i] = 0; 
        continue;
    }

    const k = C1 - C0; 
    result[i] = inputData[C0] * (1 - k) + inputData[C2] * k;
  }
  return result;
}

function createBlob(data: Float32Array, currentSampleRate: number): Blob {
  let audioDataToProcess = data;

  if (currentSampleRate !== 16000) {
    // console.log(`Resampling audio from ${currentSampleRate}Hz to 16000Hz.`); // Optional: for debugging
    audioDataToProcess = resampleLinear(data, currentSampleRate, 16000);
  }
  
  const l = audioDataToProcess.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = Math.max(-32768, Math.min(32767, audioDataToProcess[i] * 32768));
  }

  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000', 
  };
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const numFrames = data.length / 2 / numChannels; // Each sample is 2 bytes (Int16)
  if (numFrames === 0 || isNaN(numFrames)) {
     // Return a minimal silent buffer if no valid data
    return ctx.createBuffer(numChannels || 1, 1, sampleRate || ctx.sampleRate);
  }

  const buffer = ctx.createBuffer(
    numChannels,
    numFrames,
    sampleRate,
  );

  const dataInt16 = new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2);
  
  for (let c = 0; c < numChannels; c++) {
    const channelData = buffer.getChannelData(c);
    for (let i = 0; i < numFrames; i++) {
      channelData[i] = dataInt16[i * numChannels + c] / 32768.0;
    }
  }

  return buffer;
}

export {createBlob, decode, decodeAudioData, encode};