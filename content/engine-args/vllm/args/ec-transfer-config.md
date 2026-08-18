---
schema: 1
engine: vllm
primaryName: "--ec-transfer-config"
title: "--ec-transfer-config"
summary: JSON-объект `ECTransferConfig` для разнесенного энкодера мультимодальных моделей — передача эмбеддингов из отдельного encoder-инстанса в prefill/decode-инстанс. Узкая интеграция: в дереве зарегистрированы только эталонный и CPU-коннектор, эталонный сам апстрим называет reference pathway.
group: VllmConfig
related:
  - --kv-transfer-config
  - --mm-encoder-only
  - --mm-encoder-tp-mode
  - --limit-mm-per-prompt
  - --disable-chunked-mm-input
  - --max-num-batched-tokens
  - --headless
---

# --ec-transfer-config

## Кратко

`--ec-transfer-config` заполняет `ECTransferConfig` (`vllm/config/ec_transfer.py`) — конфигурацию передачи encoder cache (EC), то есть эмбеддингов, которые вычислил vision-энкодер мультимодальной модели. Он позволяет вынести энкодер в отдельный процесс и переиспользовать его результат между инстансами.

Оценивайте это как раннюю интеграцию, а не как штатную ручку. В реестре `ECConnectorFactory` зарегистрированы всего два коннектора: `ECExampleConnector` (апстрим прямо называет его «the current reference pathway») и `ECCPUConnector`. Готовые сценарии живут в `examples/disaggregated/disaggregated_encoder/`, тесты — в `tests/v1/ec_connector`. Для одиночного мультимодального сервера флаг не нужен: энкодер и так работает в том же процессе.

## Оригинальная справка

```text
The configurations for distributed EC cache transfer.
```

## Паспорт аргумента

- Флаги: `--ec-transfer-config`
- Группа argparse: `VllmConfig`
- Тип значения: JSON-объект (либо точечные под-флаги `--ec-transfer-config.<поле> <значение>`)
- Допустимые значения: поля `ECTransferConfig`; имя коннектора — из реестра, не статический список
- Значение по умолчанию: `None` — разнесенный энкодер выключен
- Эффективное значение: `ECTransferConfig.__post_init__` заполняет `engine_id` случайным UUID, если он не задан
- Где объявлен: `vllm/config/vllm.py:VllmConfig.ec_transfer_config`
- Этап применения: разбор CLI → создание EC-коннектора в планировщике и в исполнителе → обработка мультимодальных входов каждого запроса

## Что меняет в движке

Поля повторяют структуру `KVTransferConfig`, но для эмбеддингов энкодера:

| Ключ | По умолчанию | Что делает |
| --- | --- | --- |
| `ec_connector` | `None` | имя класса коннектора из реестра `ECConnectorFactory` |
| `ec_role` | `None` | `ec_producer` (энкодер), `ec_consumer` (prefill/decode) или `ec_both`. Обязателен при заданном `ec_connector` |
| `ec_connector_module_path` | `None` | путь к модулю для коннектора вне дерева vLLM |
| `ec_connector_extra_config` | `{}` | произвольные параметры коннектора |
| `engine_id` | `None` → случайный UUID | идентификатор инстанса в обмене |
| `ec_buffer_device` | `"cuda"` | где держится буфер; в docstring прямо сказано, что поддерживается только `cuda` |
| `ec_buffer_size` | `1e9` | размер буфера в байтах |
| `ec_rank` | `None` | ранг: 0 для энкодера, 1 для PD-инстанса; поддерживается только 1P1D |
| `ec_parallel_size` | `1` | число параллельных инстансов |
| `ec_ip`, `ec_port` | `127.0.0.1`, `14579` | адрес соединения |

Отдельного внимания заслуживает производное свойство `is_encode_only` (`ec_producer` без `ec_consumer`): такой инстанс **не выделяет KV-cache вообще** — `GPUModelRunner.get_kv_cache_spec` возвращает пустой словарь. Encoder-инстанс тратит VRAM только на веса энкодера и буфер эмбеддингов.

`compute_hash()` возвращает хеш пустого списка: на граф вычислений конфиг не влияет.

## Значения и формат

- Обе формы: `--ec-transfer-config '{"ec_connector":"ECExampleConnector","ec_role":"ec_producer"}'` и `--ec-transfer-config.ec_connector ECExampleConnector`. Точечные под-флаги должны использовать одно написание флага и не смешиваться с полной JSON-строкой.
- Значение валидируется на разборе CLI как датакласс; недопустимая роль или неизвестный ключ отвергаются сразу.
- **Список коннекторов собирается в runtime** из `ECConnectorFactory` (`vllm/distributed/ec_transfer/ec_connector/factory.py`). На момент снятого снимка там ровно две записи — `ECExampleConnector` и `ECCPUConnector`; сверяйтесь с этим файлом на своей сборке.
- `ec_role` без `ec_connector` допустим и ничего не включает; обратное отвергается.

## Когда использовать

- **Отдельный флот vision-энкодеров.** Единственный оформленный сценарий: энкодеры масштабируются независимо от языковой модели, а их результат переиспользуется несколькими PD-инстансами.
- **Только по готовым сценариям из `examples/disaggregated/disaggregated_encoder/`.** Разворачивать схему «с нуля» по одному этому флагу непрактично: нужны согласованные роли, ранги и адреса на всех инстансах.
- **Не включайте на одиночном мультимодальном сервере.** Энкодер выполняется в том же процессе, а его результат уже кэшируется локально (`encoder_cache_size` выводится из `--max-num-batched-tokens`).
- **Не считайте это production-механизмом** в текущем виде: эталонный коннектор существует ради демонстрации протокола.

## Влияние на производительность и память

- **VRAM.** `ec_buffer_size` резервируется на карте (`ec_buffer_device: "cuda"`). Encode-only инстанс, наоборот, экономит всю память KV-cache, поскольку не выделяет ее.
- **TTFT.** Смысл схемы — убрать энкодер с критического пути prefill и переиспользовать эмбеддинги между процессами; выигрыш появляется при повторяющихся изображениях и при существенной доле текстовых запросов.
- **Сеть.** Эмбеддинги мультимодальных элементов заметно крупнее токенов; пропускная способность канала между инстансами становится ограничителем.
- **Время старта.** Инициализация коннектора выполняется до готовности сервера.

## Взаимодействие с другими аргументами

- `--kv-transfer-config`: независимый механизм для KV, а не для эмбеддингов; в схеме E→P→D обычно используются оба.
- `--mm-encoder-only`: отдельный режим «только энкодер» на уровне мультимодального конфига; с ролью `ec_producer` их назначения пересекаются, но это разные механизмы.
- `--limit-mm-per-prompt`, `--disable-chunked-mm-input`, `--mm-encoder-tp-mode`: настройки самого мультимодального тракта; действуют независимо.
- Подмена локального менеджера encoder cache на стороне планировщика — соседний, но ортогональный механизм: это поле `VllmConfig.ec_manager_config` (`EncoderCacheManagerConfig.encoder_cache_manager_cls`), собственного CLI-флага у него нет.
- `--headless`: encoder-инстансу HTTP-фасад обычно не нужен.
- `--max-num-batched-tokens`: из него выводится размер локального encoder cache — это отдельная от передачи величина.

## Типовые проблемы и диагностика

- **Симптом:** `Please specify ec_role when ec_connector is set, supported roles are ...` **Лечение:** добавить `ec_role`.
- **Симптом:** `Unsupported ec_role: X.` **Лечение:** одно из `ec_producer`, `ec_consumer`, `ec_both`.
- **Симптом:** `Unsupported connector type: X` при старте. **Причина:** коннектора нет в реестре. **Лечение:** сверить имя с `vllm/distributed/ec_transfer/ec_connector/factory.py` либо задать `ec_connector_module_path`.
- **Симптом:** `ec_transfer_config must be set to create a connector`. **Причина:** внутренняя ошибка порядка инициализации; на практике означает, что конфиг не дошел до фабрики. **Лечение:** проверить, что флаг задан на том инстансе, который создает коннектор.
- **Симптом:** encoder-инстанс не отвечает на генерацию. **Причина:** ожидаемое поведение `is_encode_only` — KV-cache не выделяется, языковая модель не выполняется. **Лечение:** направлять запросы на PD-инстанс.
- **Подтверждение принятого значения:** строка `Creating connector with name: X and engine_id: ...` в логе старта.

## Примеры

```bash
vllm serve /models/Qwen3-VL-4B --ec-transfer-config '{"ec_connector":"ECExampleConnector","ec_role":"ec_producer","ec_rank":0}' --headless
```

```bash
vllm serve /models/Qwen3-VL-4B --ec-transfer-config '{"ec_connector":"ECExampleConnector","ec_role":"ec_consumer","ec_rank":1}' --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/ec_transfer.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/distributed/ec_transfer/ec_connector/factory.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/docs/features/disagg_encoder.md`
