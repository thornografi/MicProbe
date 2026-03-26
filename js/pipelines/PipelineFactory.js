/**
 * PipelineFactory - Pipeline Strategy Factory
 * OCP: Yeni pipeline eklemek icin sadece PIPELINE_MAP'e ekle
 *
 * Factory Method Pattern: Pipeline tipine gore dogru strategy instance'i dondurur
 */
import DirectPipeline from './DirectPipeline.js';
import StandardPipeline from './StandardPipeline.js';
import ScriptProcessorPipeline from './ScriptProcessorPipeline.js';
import WorkletPipeline from './WorkletPipeline.js';
import { PIPELINE_TYPES } from '../modules/constants.js';

// OCP: Yeni pipeline eklemek icin buraya ekle
const PIPELINE_MAP = {
  [PIPELINE_TYPES.DIRECT]: DirectPipeline,
  [PIPELINE_TYPES.STANDARD]: StandardPipeline,
  [PIPELINE_TYPES.SCRIPTPROCESSOR]: ScriptProcessorPipeline,
  [PIPELINE_TYPES.WORKLET]: WorkletPipeline
};

/**
 * Pipeline strategy instance'i olustur
 * @param {string} pipelineType - Pipeline tipi (direct, standard, scriptprocessor, worklet)
 * @param {AudioContext} audioContext - Web Audio Context
 * @param {MediaStreamAudioSourceNode} sourceNode - Mikrofon source node
 * @param {MediaStreamAudioDestinationNode} destinationNode - Record destination node
 * @returns {BasePipeline} - Pipeline strategy instance
 * @throws {Error} - Bilinmeyen pipeline tipi
 */
export function createPipeline(pipelineType, audioContext, sourceNode, destinationNode) {
  const PipelineClass = PIPELINE_MAP[pipelineType];

  if (!PipelineClass) {
    throw new Error(`Bilinmeyen pipeline tipi: ${pipelineType}. Gecerli tipler: ${Object.keys(PIPELINE_MAP).join(', ')}`);
  }

  return new PipelineClass(audioContext, sourceNode, destinationNode);
}

/**
 * Desteklenen pipeline tiplerini dondur
 * @returns {string[]} - Pipeline tipi listesi
 */
export function getSupportedPipelines() {
  return Object.keys(PIPELINE_MAP);
}

/**
 * Pipeline tipinin gecerli olup olmadigini kontrol et
 * @param {string} pipelineType - Pipeline tipi
 * @returns {boolean}
 */
export function isPipelineSupported(pipelineType) {
  return pipelineType in PIPELINE_MAP;
}

/**
 * WebAudio gerektiren pipeline'lari dondur
 * (direct haric tum pipeline'lar)
 * @returns {string[]}
 */
export function getWebAudioPipelines() {
  return Object.keys(PIPELINE_MAP).filter(type => type !== PIPELINE_TYPES.DIRECT);
}

export default {
  createPipeline,
  getSupportedPipelines,
  isPipelineSupported,
  getWebAudioPipelines
};
