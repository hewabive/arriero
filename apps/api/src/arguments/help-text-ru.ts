import type { ArgumentOption } from "@arriero/core";

export const categoryNamesRu: Record<string, string> = {
  "common params": "Общие параметры",
  "sampling params": "Параметры сэмплинга",
  "speculative params": "Параметры speculative decoding",
  "example-specific params": "Параметры llama-server",
  "deprecated params": "Устаревшие параметры",
};

export function categoryNameRu(category: string) {
  return categoryNamesRu[category] ?? category;
}

export const helpRuOverlay: Record<string, string> = {
  "--model":
    "Путь к GGUF-модели, которую должен загрузить экземпляр llama-server.",
  "--ctx-size":
    "Размер контекста в токенах. 0 означает взять значение из модели, если оно доступно.",
  "--n-gpu-layers":
    "Сколько слоев модели выгрузить в VRAM. Значение auto обычно является хорошим стартом, all пробует выгрузить все слои.",
  "--host":
    "Адрес, на котором llama-server будет слушать HTTP-запросы. Для доступа только с этого компьютера обычно достаточно 127.0.0.1.",
  "--port": "TCP-порт HTTP-сервера.",
  "--api-prefix":
    "Префикс URL без завершающего слеша, если сервер должен жить не в корне HTTP-пути.",
  "--parallel":
    "Количество серверных слотов для одновременной обработки запросов. -1 включает автоматический выбор.",
  "--batch-size":
    "Логический максимум batch size при обработке промпта. Влияет на производительность и потребление памяти.",
  "--ubatch-size":
    "Физический micro-batch size. Часто имеет смысл менять вместе с batch-size при нехватке памяти.",
  "--threads":
    "Количество CPU-потоков для генерации. -1 означает автоматический выбор.",
  "--threads-batch":
    "Количество CPU-потоков для batch/prompt processing. Если не задано, наследует --threads.",
  "--flash-attn":
    "Включение Flash Attention: on, off или auto. Может улучшить скорость и снизить память, если backend поддерживает.",
  "--cache-type-k":
    "Тип данных KV-cache для ключей. Меньшие типы экономят память, но могут влиять на качество/скорость.",
  "--cache-type-v":
    "Тип данных KV-cache для значений. Меньшие типы экономят память, но могут влиять на качество/скорость.",
  "--split-mode": "Стратегия распределения модели по нескольким GPU.",
  "--tensor-split": "Доли распределения модели по GPU, например 3,1.",
  "--main-gpu":
    "Основной GPU для режима split-mode=none или промежуточных результатов в split-mode=row.",
  "--mmproj": "Путь к multimodal projector для vision/multimodal моделей.",
  "--mmproj-auto":
    "Автоматически использовать mmproj, если он доступен, например при загрузке с Hugging Face.",
  "--alias": "Псевдоним модели, который будет виден в API.",
  "--tags": "Информационные теги модели, не используются для маршрутизации.",
  "--models-dir": "Каталог моделей для router-режима llama-server.",
  "--models-preset": "Путь к INI-файлу пресетов моделей для router-режима.",
  "--models-max":
    "Максимум одновременно загруженных моделей в router-режиме. 0 означает без лимита.",
  "--models-autoload": "Автоматически загружать модели в router-режиме.",
  "--metrics": "Включить endpoint метрик Prometheus.",
  "--props": "Разрешить изменение глобальных свойств через POST /props.",
  "--slots": "Показывать endpoint мониторинга слотов.",
  "--cache-prompt": "Включить кэширование промпта.",
  "--cache-reuse":
    "Минимальный размер чанка для повторного использования prompt cache через KV shifting.",
  "--timeout": "Таймаут чтения/записи HTTP-сервера в секундах.",
  "--threads-http": "Количество потоков для обработки HTTP-запросов.",
  "--api-key":
    "API-ключи для аутентификации, можно передать несколько через запятую.",
  "--api-key-file": "Файл со списком API-ключей.",
  "--ssl-key-file": "PEM-файл приватного SSL-ключа.",
  "--ssl-cert-file": "PEM-файл SSL-сертификата.",
  "--ui": "Включить или отключить встроенный Web UI llama-server.",
  "--embedding":
    "Ограничить сервер embedding-сценарием. Используйте с dedicated embedding моделями.",
  "--rerank": "Включить endpoint reranking.",
  "--chat-template":
    "Задать Jinja-шаблон чата вручную вместо шаблона из метаданных модели.",
  "--chat-template-file": "Загрузить Jinja-шаблон чата из файла.",
  "--jinja": "Включить или отключить Jinja template engine.",
  "--reasoning": "Управляет reasoning/thinking режимом: on, off или auto.",
  "--reasoning-format":
    "Формат обработки thought-тегов и поля reasoning_content.",
  "--reasoning-budget":
    "Бюджет токенов для thinking: -1 без ограничения, 0 сразу завершить, N ограничить.",
  "--sleep-idle-seconds":
    "Через сколько секунд простоя сервер переводит модель в sleep; -1 отключает.",
  "--lora":
    "Путь к LoRA-адаптеру. Несколько адаптеров можно передать через запятую.",
  "--lora-scaled":
    "LoRA-адаптеры с пользовательским scale в формате FNAME:SCALE.",
  "--log-file": "Путь к файлу, куда llama-server будет писать лог.",
  "--verbosity": "Порог подробности логов llama.cpp.",
};

export function optionFallbackHelpRu(option: ArgumentOption) {
  return `Оригинальная справка llama.cpp: ${option.help || option.names.join(", ")}`;
}
