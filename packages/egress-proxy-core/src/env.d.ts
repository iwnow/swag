// Декодирование Basic-заголовка прокси (спека 026, 4.7). lib ES2023 не содержит atob; DOM и @types/node сюда не подключаются.
declare function atob(data: string): string;
