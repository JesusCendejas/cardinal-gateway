// Minimal type shim for `selfsigned@3.0.1`.
//
// The package ships no `.d.ts`, and there is no `@types/selfsigned` on npm.
// This declares only the `generate()` surface used by fake-tls-server.ts so
// `tsc --noEmit` stays strict instead of falling back to `any` or a ts-ignore.
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
