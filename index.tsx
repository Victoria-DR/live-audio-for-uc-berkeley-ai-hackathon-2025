/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = '';
  @state() error = '';

  private client: GoogleGenAI;
  private session: Session;
  // Use browser's default sample rate for inputAudioContext to avoid conflicts with MediaStream.
  // Resampling will be handled in createBlob if necessary.
  private inputAudioContext = new AudioContext();
  private outputAudioContext = new AudioContext({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: MediaStreamAudioSourceNode; // Corrected type
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();

  static styles = css`
    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 10vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;

      button {
        outline: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.1);
        width: 64px;
        height: 64px;
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        margin: 0;

        &:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      }

      button[disabled] {
        display: none;
      }
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();

    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });

    this.outputNode.connect(this.outputAudioContext.destination);
    // The inputNode for the visualizer is already created from inputAudioContext.
    // It will receive audio at inputAudioContext.sampleRate.
    // Connect GainNode to destination if it's part of an analysis chain that needs output.
    // Often, GainNodes for analysis are not connected to destination if their output is processed by an AnalyserNode.
    // However, connecting it ensures it's active in the audio graph if there are any browser quirks.
    // this.inputNode.connect(this.inputAudioContext.destination); // Optional: if visualizer needs gain output


    this.initSession();
  }

  private async initSession() {
    const model = 'gemini-2.5-flash-preview-native-audio-dialog';

    try {
      this.session = await this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            this.updateStatus('Opened');
          },
          onmessage: async (message: LiveServerMessage) => {
            const audio =
              message.serverContent?.modelTurn?.parts[0]?.inlineData;

            if (audio) {
              this.nextStartTime = Math.max(
                this.nextStartTime,
                this.outputAudioContext.currentTime,
              );

              const audioBuffer = await decodeAudioData(
                decode(audio.data),
                this.outputAudioContext,
                24000, // API output is 24kHz
                1,
              );
              const source = this.outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              source.addEventListener('ended', () =>{
                this.sources.delete(source);
              });

              source.start(this.nextStartTime);
              this.nextStartTime = this.nextStartTime + audioBuffer.duration;
              this.sources.add(source);
            }

            const interrupted = message.serverContent?.interrupted;
            if(interrupted) {
              for(const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
            }
          },
          onerror: (e: ErrorEvent) => {
            this.updateError(e.message);
          },
          onclose: (e: CloseEvent) => {
            this.updateStatus('Close:' + e.reason);
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Orus'}},
            // languageCode: 'en-GB'
          },
          systemInstruction: "You are an expert music teacher. Provide detailed, step-by-step explanations for music theory concepts. Use simple language and examples to help beginners understand. If a user asks about a specific topic, explain it thoroughly and provide practical exercises or examples.",
        },
      });
    } catch (e) {
      console.error(e);
      this.updateError(`Error initializing session: ${e.message}`);
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
    this.error = ''; // Clear previous errors when status updates
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }

    // Ensure audio contexts are running
    if (this.inputAudioContext.state === 'suspended') {
      await this.inputAudioContext.resume();
    }
    if (this.outputAudioContext.state === 'suspended') {
      await this.outputAudioContext.resume();
    }
    
    this.updateStatus('Requesting microphone access...');
    this.error = '';


    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000, // Still request 16kHz, browser may provide different if not supported
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      
      const audioTrackSettings = this.mediaStream.getAudioTracks()[0].getSettings();
      const actualStreamSampleRate = audioTrackSettings.sampleRate;
      console.log(`Requested microphone at 16000 Hz, got stream at ${actualStreamSampleRate} Hz.`);
      console.log(`InputAudioContext is running at ${this.inputAudioContext.sampleRate} Hz.`);

      this.updateStatus('Microphone access granted. Starting capture...');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      // Connect sourceNode (mic stream) to inputNode (gain for visualizer).
      this.sourceNode.connect(this.inputNode);


      const bufferSize = 4096; // Adjusted buffer size
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1, // Number of input channels
        1, // Number of output channels
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0); // Assuming mono audio

        // Pass current sample rate for potential resampling in createBlob
        this.session.sendRealtimeInput({media: createBlob(pcmData, this.inputAudioContext.sampleRate)});
      };
      
      // Connect sourceNode (mic stream) also to scriptProcessorNode for data capture.
      this.sourceNode.connect(this.scriptProcessorNode);
      
      // Connect scriptProcessorNode to destination to keep it processing.
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);


      this.isRecording = true;
      this.updateStatus('🔴 Recording... Capturing PCM chunks.');
    } catch (err) {
      console.error('Error starting recording:', err);
      this.updateError(`Error starting recording: ${err.message}`);
      this.stopRecording(); // Clean up if starting failed
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext) {
      if (!this.mediaStream && !this.sourceNode && !this.scriptProcessorNode) {
        this.updateStatus('Recording already stopped or not started.');
        return;
      }
    }
      
    this.updateStatus('Stopping recording...');

    this.isRecording = false;

    if (this.scriptProcessorNode) {
      this.scriptProcessorNode.disconnect();
      this.scriptProcessorNode.onaudioprocess = null; 
      this.scriptProcessorNode = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    
    this.updateStatus('Recording stopped. Click Start to begin again.');
  }

  private reset() {
    this.stopRecording(); 
    if (this.session) {
       this.session.close();
    }
    setTimeout(() => {
      this.initSession();
      this.updateStatus('Session cleared and reinitialized.');
    }, 100);
  }

  render() {
    return html`
      <div>
        <div class="controls">
          <button
            id="resetButton"
            @click=${this.reset}
            ?disabled=${this.isRecording}
            aria-label="Reset Session">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="40px"
              viewBox="0 -960 960 960"
              width="40px"
              fill="currentColor">
              <path
                d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
            </svg>
          </button>
          <button
            id="startButton"
            @click=${this.startRecording}
            ?disabled=${this.isRecording}
            aria-label="Start Recording">
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#c80000"
              xmlns="http://www.w3.org/2000/svg">
              <circle cx="50" cy="50" r="50" />
            </svg>
          </button>
          <button
            id="stopButton"
            @click=${this.stopRecording}
            ?disabled=${!this.isRecording}
            aria-label="Stop Recording">
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#000000"
              xmlns="http://www.w3.org/2000/svg">
              <rect x="0" y="0" width="100" height="100" rx="15" />
            </svg>
          </button>
        </div>

        <div id="status" role="status" aria-live="polite"> 
          ${this.error ? `Error: ${this.error}` : this.status} 
        </div>
        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}></gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}