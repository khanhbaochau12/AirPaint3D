declare module '@mediapipe/hands' {
  export interface Landmark {
    x: number;
    y: number;
    z?: number;
    visibility?: number;
  }

  export type NormalizedLandmarkList = Landmark[];

  export interface Results {
    multiHandLandmarks?:  NormalizedLandmarkList[];
    multiHandedness?:     Array<{ label: string; score: number }>;
    image:                HTMLCanvasElement;
  }

  export interface HandsConfig {
    locateFile?: (file: string) => string;
  }

  export interface HandsOptions {
    maxNumHands?:             number;
    modelComplexity?:         number;   // 0 = lite | 1 = full
    minDetectionConfidence?:  number;
    minTrackingConfidence?:   number;
  }

  export class Hands {
    constructor(config?: HandsConfig);
    setOptions(options: HandsOptions): void;
    onResults(callback: (results: Results) => void): void;
    send(inputs: {
      image: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;
    }): Promise<void>;
    close(): Promise<void>;
  }
}
