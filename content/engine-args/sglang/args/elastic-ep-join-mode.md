---
schema: 1
engine: sglang
primaryName: "--elastic-ep-join-mode"
title: "--elastic-ep-join-mode"
summary: Помечает процесс как присоединяющийся к уже работающей elastic EP-группе: `recover` возвращает упавший ранг на прежнее место, `scale` добавляет новую TP-группу сверх исходного размера. Без `--elastic-ep-backend` отвергается ассертом.
group: exec.moe
related:
  - --elastic-ep-backend
  - --elastic-ep-join-rank-offset
  - --elastic-ep-initial-size
  - --elastic-ep-rejoin
  - --elastic-ep-scale-timeout
  - --max-ep-size
  - --node-rank
  - --nnodes
  - --moe-dense-tp-size
  - --tp-size
---

# --elastic-ep-join-mode

## Кратко

Обычный процесс SGLang считает себя частью группы, которую он сам и создает. Присоединяющийся процесс — нет: он подключается к WORLD, которую уже держит работающий сервер. Аргумент и объявляет эту роль. От него зависит, как процесс рассчитает свой глобальный ранг, какие проверки геометрии для него отключатся и будет ли он ждать прогрева. Механизм elastic EP целиком описан в документе `--elastic-ep-backend`; здесь — только про роль процесса.

## Оригинальная справка

```text
Join mode for elastic EP. 'recover' rejoins an existing slot after a fault. 'scale' joins as a new rank beyond the original group size and requires --node-rank 1.
```

## Паспорт аргумента

- Флаги: `--elastic-ep-join-mode`
- Группа: `exec.moe`
- Тип значения: перечисление
- Допустимые значения: `scale`, `recover`
- Значение по умолчанию: `null` — процесс не является присоединяющимся
- Эффективное значение: подставляется `recover`, если задан устаревший `--elastic-ep-rejoin` и режим не указан явно; при явном конфликтующем значении — ассерт
- Где объявлен: `ServerArgs.ep_join_mode`, файл — `sglang/python/sglang/srt/server_args.py` (имя поля отличается от имени флага: `cli_name="--elastic-ep-join-mode"`)
- Статус: обычный, часть молодой подсистемы elastic EP
- Этап применения: `__post_init__` (`_handle_elastic_ep`, `check_server_args`) → выделение портов → инициализация `ElasticEPStateManager` → загрузка весов → HTTP-прогрев

## Что меняет в движке

Значение читается через два свойства `ServerArgs`: `is_ep_joiner` (режим задан) и `is_ep_scale_joiner` (режим ровно `scale`). Дальше они разводят поведение:

- **Проверки геометрии.** `check_server_args` пропускает требование `tp_size * pp_size % nnodes == 0` для `scale`-присоединенца: его TP-группа не обязана делиться на исходное число узлов. По той же причине `_handle_eplb_and_dispatch` не требует `ep_size > 1` при `scale`.
- **Порты.** Для `scale`-присоединенца база ZMQ-портов считается от `--port`, а не от `--dist-init-addr`, чтобы не столкнуться с портами первичной развертки. Для любого присоединенца пропускается проверка занятости `dist_init_port` — этот порт уже слушает первичный процесс.
- **Стартовое состояние.** `ElasticEPStateManager._init_joiner_state` обнуляет маску живых рангов и поднимает единицу только на своем глобальном ранге. Для `scale` эффективный размер группы считается как `--elastic-ep-join-rank-offset + --tp-size`, исходный — из `--elastic-ep-initial-size`, и сразу выставляется признак «расширение уже произошло». Для `recover` эффективный и исходный размеры равны текущему world size.
- **Присоединение.** `scale`-процесс на старте регистрирует свою когорту в общем TCPStore (`register_scale_cohort`) и ждет, пока первичная группа примет ее; первичная сторона видит это в `maybe_join_ep_ranks`.
- **Загрузка весов.** Барьер после загрузки для присоединенца пропускается (`dist_barrier_after_load`) — остальные ранги уже давно обслуживают трафик.
- **Прогрев.** HTTP-слой пропускает warmup для `scale`-присоединенца.
- Логи присоединяющегося процесса помечаются тегом `JOINER`, первичного — `PRIMARY`.

## Значения и формат

- Не задан — обычный процесс. Это единственный корректный вариант для первичной развертки.
- `recover` — процесс поднимается вместо упавшего ранга и занимает его прежний слот. Требует только заданного `--elastic-ep-backend`. Первичная сторона примет его в `maybe_recover_ep_ranks`, когда опрос состояния пира покажет готовность.
- `scale` — процесс добавляет к группе новую TP-группу. Дополнительно требует `--node-rank 1` и `--elastic-ep-join-rank-offset` больше нуля (это текущий эффективный размер EP-группы). При активном расширении также обязателен `--elastic-ep-initial-size`, не превышающий смещение, и `offset + tp_size` не больше `--max-ep-size`; при `--tp-size 1` дополнительно требуется `--moe-dense-tp-size 1`.

## Когда использовать

- Упал узел EP-группы, сервер продолжает отдавать трафик на живых рангах: поднимите процесс с `--elastic-ep-join-mode recover` и теми же параллельными параметрами, что были у упавшего.
- Плановое расширение: сначала `POST /scale_elastic_ep {"new_ep_size": N}` на работающем сервере, затем запуск присоединяющейся группы с `scale`, `--node-rank 1` и корректным смещением рангов.
- Не задавайте режим на первичной развертке: процесс перестанет проверять геометрию и будет ждать чужую WORLD.
- Не используйте `recover` после того, как группа уже расширялась: код явно отвечает `Elastic EP rank recovery is unsupported after runtime scale-up. Restart the expanded deployment.`

## Влияние на производительность и память

- На установившийся режим аргумент не влияет: он меняет только сценарий старта процесса.
- Присоединяющийся процесс грузит веса с диска обычным путем, поэтому время его входа в строй — это время загрузки модели плюс ожидание когорты.
- После успешного присоединения EPLB (если включен) пересчитывает раскладку по расширенному или восстановленному набору рангов; это разовая пауза на всей группе.

## Взаимодействие с другими аргументами

- `--elastic-ep-backend`: обязателен, иначе `AssertionError: --elastic-ep-join-mode requires --elastic-ep-backend to be set.`
- `--elastic-ep-join-rank-offset`: обязателен и положителен для `scale`; вне `scale` его вообще нельзя задавать.
- `--elastic-ep-initial-size`: обязателен для `scale`-присоединенца при активном расширении.
- `--max-ep-size`: ограничивает суммарный размер после присоединения.
- `--node-rank`: для `scale` обязан быть 1.
- `--elastic-ep-rejoin`: устаревший способ выразить `recover`.
- `--elastic-ep-scale-timeout`: сколько первичная группа будет ждать присоединенца.
- `--tp-size`, `--moe-dense-tp-size`: размер присоединяющейся группы и требование к плотным MLP при `--tp-size 1`.

## Типовые проблемы и диагностика

- `AssertionError: --elastic-ep-join-mode requires --elastic-ep-backend to be set.` — забыт бэкенд.
- `AssertionError: Elastic EP scale-up requires one joining TP group at --node-rank 1 (got N).` — неверный `--node-rank`.
- `AssertionError: Elastic EP scale joiners require --elastic-ep-join-rank-offset set to the current effective EP size.` — смещение не задано или равно нулю.
- `AssertionError: Elastic EP scale joiners require --elastic-ep-initial-size set to the primary deployment's launch-time EP size.` — не передан исходный размер.
- `Requested target EP size N does not match joining cohort target M` в логе первичной группы — `new_ep_size` в HTTP-запросе и фактическая геометрия присоединенца разошлись.
- `Timed out waiting for ranks to join target EP size N` — присоединенец не успел; см. `--elastic-ep-scale-timeout`.
- `AssertionError: --elastic-ep-rejoin (deprecated) conflicts with --elastic-ep-join-mode <mode>.` — заданы оба флага с разным смыслом.
- Состояние процесса удобно смотреть по префиксам `[Elastic EP]` и тегам `JOINER`/`PRIMARY` в логе, а состояние группы — через `GET /is_scaling_elastic_ep` на первичном сервере.

## Примеры

Возврат упавшего ранга:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --pp-size 1 --moe-a2a-backend deepep --deepep-mode normal --elastic-ep-backend mooncake --dist-init-addr 10.0.0.1:20000 --nnodes 2 --node-rank 1 --elastic-ep-join-mode recover
```

Присоединение новой группы при расширении с 8 до 16:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --dp-size 8 --ep-size 8 --pp-size 1 --enable-dp-attention --enable-dp-lm-head --moe-a2a-backend nixl --elastic-ep-backend mooncake --max-ep-size 16 --disable-cuda-graph --load-balance-method round_robin --tokenizer-worker-num 1 --dist-init-addr 10.0.0.1:20000 --nnodes 2 --node-rank 1 --elastic-ep-join-mode scale --elastic-ep-join-rank-offset 8 --elastic-ep-initial-size 8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/elastic_ep/elastic_ep.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/layers/dp_attention.py`
