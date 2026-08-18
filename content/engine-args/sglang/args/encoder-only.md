---
schema: 1
engine: sglang
primaryName: "--encoder-only"
title: "--encoder-only"
summary: Запускает не языковой сервер, а отдельный сервер визуального энкодера для EPD-развертывания: другой entrypoint, другой набор HTTP-маршрутов, загружаются только веса ViT. Не OpenAI-совместимый сервер.
group: disagg
related:
  - --language-only
  - --encoder-urls
  - --encoder-register-urls
  - --encoder-bootstrap-port
  - --encoder-transfer-backend
  - --enable-adaptive-dispatch-to-encoder
  - --enable-prefix-mm-cache
  - --enable-mm-global-cache
  - --mm-feature-transport
  - --disaggregation-mode
  - --grpc-port
  - --grpc-mode
  - --smg-grpc-mode
  - --tp-size
  - --dp-size
  - --port
---

# --encoder-only

## Кратко

Это самый «переключающий» флаг во всей группе: он меняет entrypoint. `sglang.launch_server` при `--encoder-only` вызывает не `entrypoints/http_server.py:launch_server`, а `disaggregation/encode_server.py:launch_server` — совершенно другое FastAPI-приложение, у которого нет ни `/generate`, ни `/v1/*`. Такой процесс умеет только считать эмбеддинги изображений/аудио по внутреннему протоколу и отдавать их языковому серверу, запущенному с `--language-only`. Веса языковой модели он не грузит.

## Оригинальная справка

```text
For MLLM with an encoder, launch an encoder-only server
```

## Паспорт аргумента

- Флаги: `--encoder-only`
- Группа: `disagg`
- Тип значения: bool (`action="store_true"`, парного `--no-*` нет)
- Допустимые значения: флаг задан / не задан
- Значение по умолчанию: `false`
- Эффективное значение: совпадает с заданным. Побочно переписывает `--mm-feature-transport`: при незаданном транспорте он авто-разрешается в `cpu`, а явный `cuda_ipc` понижается до `cpu` с предупреждением
- Где объявлен: `ServerArgs.encoder_only`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `_handle_encoder_disaggregation` (взаимные запреты, проверка архитектуры модели) → `_handle_multimodal` (выбор транспорта) → `run_server` в `sglang/launch_server.py` (выбор entrypoint) → загрузка весов (только визуальная башня)

## Что меняет в движке

### Entrypoint и маршруты

`sglang/launch_server.py:run_server` первым делом проверяет `server_args.encoder_only`:

- с `--grpc-mode`/`--smg-grpc-mode` → `disaggregation/encode_grpc_server.py:serve_grpc_encoder`;
- иначе → `disaggregation/encode_server.py:launch_server`.

HTTP-приложение энкодера объявляет ровно семь маршрутов: `POST /encode`, `POST /send`, `POST /scheduler_receive_url`, `GET /health`, `GET /health_generate`, `/start_profile`, `/stop_profile`. Никакого OpenAI-фасада тут нет — это внутренний сервис EPD, а не публичный endpoint.

### Процессы

`launch_server` энкодера при `--tp-size > 1` спавнит по одному процессу `launch_encoder` на ранги `1 … tp_size-1` (связь через ZMQ IPC), а ранг 0 живет в основном процессе как `MMEncoder`; uvicorn слушает `--host`:`--port`. Отдельная ветка `_launch_server_dp` включается при `--dp-size > 1` и требует `--tp-size 1` (`Encoder DP mode requires --dp-size > 1 and --tp-size 1`), поднимая `dp_size` воркеров и диспетчер поверх них.

### Веса

`encoder_only` пробрасывается в `ModelConfig` и оседает в `hf_config.encoder_only`. Модели-обертки читают его при построении: языковая часть не создается (`if not hasattr(config, "encoder_only") or not config.encoder_only: self.model = language_model_cls(...)`), а загрузчик весов пропускает имена, которых нет в словаре параметров. Практически это значит: в VRAM попадает визуальная башня и не попадает LLM.

## Значения и формат

- Флаг без значения.
- Взаимные запреты, проверяемые в `_handle_encoder_disaggregation`:
  - вместе с `--language-only` — `Cannot set --encoder-only and --language-only together`;
  - вместе с `--disaggregation-mode prefill|decode` — `Cannot set --encoder-only and --disaggregation-mode prefill/decode together`. Энкодер не участвует в PD-ролях: в EPD он третий, отдельный ярус;
  - вместе с `--grpc-port` (нативный gRPC) — `--grpc-port is not supported with --encoder-only: encoder disaggregation uses its own server.`
- `--enable-prefix-mm-cache` требует именно `--encoder-only`: `--enable-prefix-mm-cache requires --encoder-only to be enabled`.
- Архитектура модели должна входить в белый список EPD (Qwen2VL/Qwen2.5VL/Qwen3VL/Qwen3VL-MoE/Qwen3.5, Qwen2Audio, Qwen2.5Omni, Qwen3OmniMoe, InternS2Preview, KimiVL/KimiK2.5/KimiK3, MiMoV2). Иное — `Model type <arch> is not supported for encoder disaggregation.`
- Путь модели указывается тот же, что у языкового сервера: конфиг мультимодальный, из него берется только визуальная часть.

## Когда использовать

- VLM-нагрузка, где ViT — узкое место: изображения тяжелые, а языковая часть простаивает. Энкодеры масштабируются горизонтально независимо от prefill/decode.
- Нужно отдать энкодерам отдельные карты (например слабее), не трогая размещение LLM.
- Не запускайте как «обычный сервер, только для картинок»: у него нет OpenAI-совместимого API, клиент к нему напрямую не подключается.
- Не совмещайте с ролями PD на одном процессе — это запрещено; в EPD prefill-сервер запускается отдельно с `--language-only`.

## Влияние на производительность и память

- **VRAM.** Заметно меньше, чем у полного сервера: только визуальная башня и ее активации. KV-пул языковой модели не выделяется.
- **Транспорт эмбеддингов.** Определяется `--encoder-transfer-backend`, а не `--mm-feature-transport`: последний на энкодере принудительно `cpu` (с предупреждением, если вы просили CUDA IPC).
- **Пропускная способность.** Масштабируется числом энкодер-процессов; языковой сервер раскладывает элементы запроса по нескольким URL из `--encoder-urls`.
- **Время старта.** Меньше полного сервера: нет загрузки весов LLM, нет захвата графов decode.
- **Хост.** `--tp-size` дочерних процессов (или `--dp-size` воркеров) плюс основной — считайте RAM соответственно.

## Взаимодействие с другими аргументами

- `--language-only`: вторая половина EPD; на одном процессе взаимоисключающи.
- `--encoder-urls`: задается на языковой стороне и перечисляет адреса таких энкодеров.
- `--encoder-register-urls`: задается на энкодере, чтобы он сам зарегистрировался в `EncoderBootstrapServer` языкового сервера.
- `--encoder-transfer-backend`: как эмбеддинги доедут до языковой стороны; значение должно быть согласовано между энкодером и получателем.
- `--enable-mm-global-cache`: глобальный кеш эмбеддингов в Mooncake, включается именно на энкодере.
- `--enable-prefix-mm-cache`: требует этого флага.
- `--mm-feature-transport`: на энкодере понижается до `cpu`.
- `--tp-size` / `--dp-size`: TP работает как обычно; DP требует `--tp-size 1`.
- `--grpc-mode` / `--smg-grpc-mode`: переводят энкодер на gRPC-сервер; получателю тогда нужен `SGLANG_ENCODER_MM_RECEIVER_MODE=grpc` и URL вида `grpc://host:port`.

## Типовые проблемы и диагностика

- `ValueError: Cannot set --encoder-only and --language-only together` — вы пытаетесь сделать один процесс сразу двумя ярусами.
- `ValueError: Cannot set --encoder-only and --disaggregation-mode prefill/decode together` — энкодер не бывает prefill'ом; в EPD prefill-сервер запускается отдельно.
- `ValueError: Model type <arch> is not supported for encoder disaggregation. Supported architectures: Qwen2VL, Qwen3VL, Qwen3.5, InternS2, Qwen2Audio, Qwen2.5Omni, Kimi, MiMoV2.` — модель вне белого списка.
- `ValueError: Encoder DP mode requires --dp-size > 1 and --tp-size 1; got dp_size=..., tp_size=...` — конфликт параллелизмов на энкодере.
- `curl http://encoder:30000/v1/models` дает 404 — так и должно быть: у энкодера нет OpenAI-фасада. Проверяйте `GET /health`.
- Предупреждение `--mm-feature-transport=cuda_ipc does not control encoder-only output transfer; using cpu for this inactive transport. Select --encoder-transfer-backend for encoder outputs.` — вы настраиваете не тот транспорт.
- Логи энкодера имеют префикс ` encode_server` (`configure_logger(server_args, prefix=" encode_server")`) — по нему легко отличить процесс в общем потоке логов.
- **В arriero:** менеджер супервизирует один процесс на инстанс и ожидает от него OpenAI-совместимый endpoint для proxy-таргета; энкодер такого фасада не имеет, а EPD требует минимум двух процессов и внешнего роутера. Поэтому `--encoder-only`-инстанс менеджером не обслуживается — это отдельный ярус развертывания вне его модели.

## Примеры

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-VL-8B-Instruct --encoder-only --encoder-transfer-backend zmq_to_scheduler --port 30000
```

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-VL-8B-Instruct --encoder-only --encoder-transfer-backend mooncake --enable-mm-global-cache --encoder-register-urls http://prefill0:8997 --port 30001
```

## Источники

- `sglang/python/sglang/launch_server.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/disaggregation/encode_server.py`
- `sglang/python/sglang/srt/disaggregation/encode_grpc_server.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/models/qwen3_vl.py`
- `sglang/docs/docs/advanced_features/epd_disaggregation.mdx`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`
