/**
 * Media artifact validation (0.8.6).
 *
 * A zero exit code is not proof that a screenshot was produced. This module
 * checks existence, size and magic bytes (PNG/JPEG) before the evidence is
 * recorded as successful.
 *
 * @module dwguard-dsh-hmos/media
 */
export interface ImageValidation {
    readonly ok: boolean;
    readonly reason?: string;
    readonly bytes?: number;
    readonly format?: 'png' | 'jpeg';
}
/** Validate a screenshot artifact without decoding the whole image. */
export declare function validateImageFile(file: string, maxBytes?: number): Promise<ImageValidation>;
