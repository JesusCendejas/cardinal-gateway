declare module 'selfsigned' {
  export interface SelfSignedAttribute {
    name: string;
    value: string;
  }

  export interface SelfSignedAltName {
    type: number;
    value?: string;
    ip?: string;
  }

  export interface SelfSignedExtension {
    name: string;
    altNames?: SelfSignedAltName[];
  }

  export interface SelfSignedOptions {
    days?: number;
    keySize?: number;
    algorithm?: string;
    extensions?: SelfSignedExtension[];
  }

  export interface SelfSignedPems {
    private: string;
    public: string;
    cert: string;
  }

  export function generate(
    attributes?: SelfSignedAttribute[],
    options?: SelfSignedOptions,
  ): SelfSignedPems;
}
