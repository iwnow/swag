// Минимум глобалов, которых нет в lib ES2023 (TextEncoder — UTF-8 для спеки 004, 4.3). DOM и @types/node сюда не подключаются.
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
