---
schema: 1
engine: sglang
primaryName: "--encoder-urls"
title: "--encoder-urls"
summary: Статический список адресов энкодер-серверов для языковой стороны EPD. Задается на сервере с `--language-only`, принимает несколько значений через пробел и лишь предзаполняет реестр, который дальше пополняется динамическими регистрациями.
group: disagg
related:
  - --language-only
  - --encoder-only
  - --encoder-register-urls
  - --encoder-bootstrap-port
  - --encoder-transfer-backend
  - --enable-adaptive-dispatch-to-encoder
  - --grpc-mode
  - --host
  - --port
---

# --encoder-urls

## Кратко

Аргумент читается только на сервере с `--language-only`. Список превращается в изменяемый массив URL, который разделяется по ссылке между `EncoderBootstrapServer` (он его пополняет при регистрации энкодеров) и приемником мультимодальных данных (он его читает). Мультимодальные элементы одного запроса раскладываются **по всем** доступным энкодерам, а не отправляются на один — то есть список задает не резерв, а пул параллельной обработки.

## Оригинальная справка

```text
List of encoder server urls.
```

## Паспорт аргумента

- Флаги: `--encoder-urls`
- Группа: `disagg`
- Тип значения: список строк; argparse получает `nargs="+"`, поэтому значения перечисляются через пробел
- Допустимые значения: `choices` нет; URL со схемой — `http://host:port`, `https://host:port` или `grpc://host:port` для gRPC-энкодеров
- Значение по умолчанию: `dataclasses.field(default_factory=list)` — то есть пустой список
- Эффективное значение: само поле не переписывается, но фактический набор адресов в runtime — это **копия** списка, которую `EncoderBootstrapServer` дальше мутирует: `list(self.server_args.encoder_urls)` в `TokenizerManager.init_disaggregation`
- Где объявлен: `ServerArgs.encoder_urls`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `_handle_encoder_disaggregation` (только информационное сообщение при пустом списке) → `TokenizerManager.init_disaggregation` (создание разделяемого списка и реестра) → на каждый мультимодальный запрос при раскладке элементов

## Что меняет в движке

### Разделяемый реестр

`init_disaggregation` создает `self.encoder_urls = list(server_args.encoder_urls)` и передает **тот же объект списка** и в `EncoderBootstrapServer(urls=...)`, и в `create_mm_receiver(encode_urls=...)`. Регистрация через `POST /register_encoder_url` добавляет адрес в этот же список, снятие — убирает. Поэтому статический список из CLI и динамические регистрации живут вместе и равноправны.

Приемник на каждый запрос делает снимок (`encode_urls = list(self.encode_urls)`), чтобы конкурентная регистрация не меняла набор посреди обработки, и замораживает этот снимок на объекте запроса (`obj.encoder_urls`) — scheduler-процесс индексирует именно его.

### Раскладка элементов

`_assign_items_by_modality(mm_data, len(encode_urls))` делит элементы **по модальностям** (изображения, видео, аудио) поровну между энкодерами: `base = num_items // encoder_num`, остаток раздается по кругу, порядок энкодеров при этом перемешивается (`random.shuffle`), а смещение переносится между модальностями ради балансировки. Каждому энкодеру уходит своя часть с собственным `part_req_id`, и языковая сторона собирает ответы обратно.

### Пустой список

Если на момент запроса адресов нет вообще:

- в `recv_mm_data` условие `len(encode_urls) == 0` немедленно возвращает `None`, и запрос идет по локальному пути;
- на пути `zmq_to_scheduler`/`mooncake` печатается `No encoder URLs available for request <rid>; processing without encoder disaggregation.`, и `need_wait_for_mm_inputs` сбрасывается в `False`, чтобы scheduler не ждал эмбеддингов, которых не будет;
- при старте с пустым списком в лог идет `--language-only is set without --encoder-urls. Encoders are expected to register dynamically via the EncoderBootstrapServer.`

## Значения и формат

- Несколько значений через пробел: `--encoder-urls http://enc0:30000 http://enc1:30001`. Запятая **не** разделитель — она станет частью адреса.
- Схема обязательна: приемник строит из адреса `"{encoder_url}/encode"`, `"{encoder_url}/send"`, `"{encoder_url}/scheduler_receive_url"` без нормализации.
- Для gRPC-энкодеров (`--encoder-only --grpc-mode`) адрес пишется как `grpc://host:port`, а получателю дополнительно нужна переменная окружения `SGLANG_ENCODER_MM_RECEIVER_MODE=grpc`.
- Завершающий слэш не нужен: он даст двойной слэш в пути.
- Порядок значений не важен: перед раскладкой индексы энкодеров перемешиваются.
- Пустой список — валидное состояние: это режим чисто динамической регистрации.

## Когда использовать

- Фиксированный набор энкодеров, известный на момент запуска: проще и надежнее, чем поднимать регистрацию.
- Смешанный режим: часть энкодеров статическая (постоянные), часть регистрируется динамически при масштабировании.
- Не задавайте на сервере без `--language-only` — значение не читается.
- Не задавайте адреса энкодеров, поднятых с другой моделью или другим `--encoder-transfer-backend`: несоответствие вылезет как невалидные эмбеддинги или таймаут, а не как ошибка конфигурации.
- Не полагайтесь только на статический список, если энкодеры перезапускаются: у реестра есть health-check и авто-эвикция, а у CLI-списка — нет.

## Влияние на производительность и память

- **Пропускная способность.** Число энкодеров в списке напрямую задает степень параллелизма обработки элементов одного запроса: восемь картинок на четыре энкодера — это по две на каждый.
- **Latency.** Раскладка снижает время обработки многоэлементного запроса; для одноэлементного она бесполезна (см. `--enable-adaptive-dispatch-to-encoder`).
- **VRAM/RAM.** На языковой стороне не влияет: список адресов.
- **Устойчивость.** Мертвый адрес в статическом списке остается в реестре, пока health-check `EncoderBootstrapServer` его не выселит (три подряд неудачных пробы; интервал и таймаут — `SGLANG_ENCODER_BOOTSTRAP_HEALTH_CHECK_INTERVAL` / `..._TIMEOUT`, `0` в интервале отключает проверку).

## Взаимодействие с другими аргументами

- `--language-only`: единственный режим, где список читается.
- `--encoder-only`: этим флагом запускаются серверы, чьи адреса сюда попадают.
- `--encoder-register-urls`: зеркальная механика с другой стороны — энкодер сам добавляет себя в реестр.
- `--encoder-bootstrap-port`: порт реестра, который пополняет тот же список.
- `--encoder-transfer-backend`: определяет протокол общения с этими URL; значение должно совпадать на обеих сторонах.
- `--enable-adaptive-dispatch-to-encoder`: решает, отправлять ли конкретный запрос в пул вообще.
- `--grpc-mode` на энкодере: меняет схему URL на `grpc://`.

## Типовые проблемы и диагностика

- `No encoder URLs available for request <rid>; processing without encoder disaggregation.` — реестр пуст: статический список не задан и никто не зарегистрировался. Запрос обработан локально.
- Запрос идет медленно и в логе только одна пара строк `[<rid>] Sending encode request to E ...` — в списке один адрес; добавьте энкодеров.
- `[<rid>] Embedding recv timeout after <t>s` — один из адресов не отвечает. Смотрите, что реестр про него думает: `GET http://<language-host>:<encoder-bootstrap-port>/list_encoder_urls`.
- 404 на стороне энкодера — вероятно, в URL есть завершающий слэш или лишний путь; адрес должен быть корнем сервера.
- Принятое значение — в дампе `server_args=` при старте; **текущий** набор адресов (с учетом регистраций) виден только через `/list_encoder_urls`.

## Примеры

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-VL-8B-Instruct --language-only --encoder-urls http://127.0.0.1:30000 http://127.0.0.1:30001 --encoder-transfer-backend zmq_to_scheduler --port 30002
```

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-VL-8B-Instruct --language-only --disaggregation-mode prefill --encoder-urls grpc://enc0:30000 --encoder-transfer-backend zmq_to_scheduler --port 30002
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/disaggregation/encode_receiver.py`
- `sglang/python/sglang/srt/disaggregation/encode_server.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/docs/docs/advanced_features/epd_disaggregation.mdx`
