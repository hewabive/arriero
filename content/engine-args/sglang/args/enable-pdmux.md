---
schema: 1
engine: sglang
primaryName: "--enable-pdmux"
title: "--enable-pdmux"
summary: Включает PD-Multiplexing — совмещение prefill и decode на одной карте через CUDA green context с разделением SM между двумя потоками. Требует `--chunked-prefill-size -1`, `--disable-overlap-schedule`, `--pp-size 1` и несовместим с PD disaggregation.
group: disagg
related:
  - --pdmux-config-path
  - --sm-group-num
  - --disaggregation-mode
  - --chunked-prefill-size
  - --disable-overlap-schedule
  - --pp-size
  - --speculative-adaptive-config
  - --enable-two-batch-overlap
  - --cuda-graph-bs
  - --cuda-graph-max-bs
---

# --enable-pdmux

## Кратко

PD-Multiplexing решает ту же проблему, что и PD disaggregation, — взаимные помехи prefill и decode, — но противоположным способом: не разносит фазы по процессам, а запускает их **на одной карте** в двух CUDA-потоках, физически поделив SM через green context. Планировщик переключается на отдельный event loop, который каждый такт продвигает decode на обычном потоке и prefill послойно на green-потоке, подбирая деление SM под текущий размер decode-батча. Ограничений много и они жесткие; на torch новее 2.6 апстрим прямо предупреждает о деградации.

## Оригинальная справка

```text
Enable PD-Multiplexing, PD running on greenctx stream.
```

## Паспорт аргумента

- Флаги: `--enable-pdmux`
- Группа: `disagg`
- Тип значения: bool (`action="store_true"`, парного `--no-*` нет)
- Допустимые значения: флаг задан / не задан
- Значение по умолчанию: `false`
- Эффективное значение: совпадает с заданным; движок его не переписывает, но отвергает четырьмя ассертами при несовместимой конфигурации
- Где объявлен: `ServerArgs.enable_pdmux`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный флаг, но фактически экспериментальный: связанный `adjust_stream_groups` помечен в исходниках как временная демонстрационная реализация
- Этап применения: разбор CLI → `check_server_args` (четыре ассерта + предупреждение по версии torch) → `Scheduler.init_pdmux` (чтение `--pdmux-config-path`, создание green-context-потоков) → `attention_backend_setup` (создание `--sm-group-num` копий decode-backend'а внимания) → захват CUDA graph по одному набору на каждую группу потоков → `dispatch_event_loop` выбирает `event_loop_pdmux`

## Что меняет в движке

### Потоки и деление SM

`init_pdmux` читает конфиг (`--pdmux-config-path`, при отсутствии — умолчания) и вызывает `initialize_stream_groups`, который через `sgl_kernel.spatial` узнает число SM на карте и строит список групп потоков:

- индекс `0` — обычная пара потоков, весь SM отдан prefill;
- индексы от `1` до `N-2` — green-context-пары с фактическим делением SM (`create_greenctx_stream_by_value`);
- последний индекс — обычная пара, весь SM отдан decode.

Деления либо берутся из `manual_divisions` конфига, либо считаются `divide_sm` по архитектурным ограничениям green context (для sm_90 — кратность 8 и минимум 8 SM на часть, для sm_80 — кратность 2 и минимум 4, для sm_70 — 2 и 2, для sm_60 — 1 и 1; иная compute capability дает `ValueError: Unsupported compute capability`). Итоговое число групп печатается: `PD-Multiplexing enabled with N stream groups, sm_counts (prefill_sm, decode_sm): [...]`.

### Event loop

`event_loop_pdmux` (`multiplex/multiplexing_mixin.py`) на каждой итерации:

1. на decode-потоке принимает запросы и обновляет running-батч;
2. на prefill-потоке берет новый prefill-батч в режиме `ForwardMode.SPLIT_PREFILL` и считает его **по нескольку слоев за такт** — число слоев выводится из `split_forward_token_budget` конфига и текущего `extend_num_tokens`;
3. подбирает индекс группы потоков под размер decode-батча (`manual_divisions` с порогами либо `decode_bs * (N-2) // decode_bs_divisor`), при смене синхронизирует оба потока;
4. переключает decode-backend внимания на соответствующий индекс (`update_decode_attn_backend`).

Когда decode-батч пуст, используется группа 0 (весь SM prefill'у); когда нет prefill'а — последняя группа (весь SM decode'у).

### CUDA graph

Захват идет **по одному набору графов на каждую группу потоков**: `_capture_one_stream(i)` в цикле по `stream_groups`. Это главный источник роста VRAM и времени старта.

## Значения и формат

- Флаг без значения.
- Обязательные условия, проверяемые ассертами в `check_server_args`:
  - `--pp-size 1` — `PD-Multiplexing is only supported with pipeline parallelism disabled (pp_size=1).`;
  - `--chunked-prefill-size -1` — `PD-Multiplexing is not compatible with chunked prefill.` Значение по умолчанию у `--chunked-prefill-size` подбирается движком, поэтому `-1` надо указать явно;
  - `--disable-overlap-schedule` — `PD-Multiplexing is not compatible with overlap schedule.`;
  - `--disaggregation-mode null` — `PD-Multiplexing is not compatible with disaggregation mode.`
- На torch ≥ 2.7 печатается предупреждение `WARNING: PD-Multiplexing may experience performance degradation with torch versions > 2.6.x.` с рекомендацией поставить torch 2.6.x. Это предупреждение, а не отказ.
- Требуется CUDA-карта с поддерживаемой compute capability и рабочий `sgl_kernel.spatial`; на других платформах инициализация не пройдет.

## Когда использовать

- Одна карта, на которой нужно и низкое ITL, и приемлемое TTFT, а разнести фазы по двум GPU нельзя. Это единственный сценарий, ради которого механизм существует.
- Готовность зафиксировать torch 2.6.x и отказаться от chunked prefill и overlap-планировщика — то есть от двух штатных оптимизаций.
- Не включайте вместе с PD disaggregation: это альтернативы, а не дополнения.
- Не включайте, если вас устраивает обычный `event_loop_overlap`: он требует меньше памяти под графы и не завязан на green context.
- Не включайте на модели, где вы полагаетесь на `--chunked-prefill-size` для ограничения пикового расхода активаций: без чанкования длинный промпт пойдет одним батчем.

## Влияние на производительность и память

- **VRAM.** Растет заметно: CUDA-графы захватываются для каждой группы потоков, и число групп по умолчанию равно 8. Отдельно `--sm-group-num` копий decode-backend'а внимания получают собственное cuda-graph-состояние (рабочее пространство при этом переиспользуется от первого backend'а).
- **Время старта.** Умножается примерно на число групп потоков: захват графов повторяется для каждой.
- **Latency.** ITL стабилизируется — decode перестает вставать в очередь за длинным prefill'ом. TTFT растет: prefill получает только часть SM.
- **Throughput.** Выигрыш зависит от того, насколько точно `adjust_stream_groups` попадает в текущее соотношение нагрузок; реализация подбора в исходниках помечена как временная.
- **Отсутствие overlap-планировщика.** Обязательный `--disable-overlap-schedule` сам по себе стоит части пропускной способности — учитывайте это при сравнении с базовой конфигурацией.

## Взаимодействие с другими аргументами

- `--pdmux-config-path`: YAML с делениями SM и порогами переключения; без него используются умолчания (8 групп, `split_forward_token_budget 65536`, `decode_bs_divisor 36`).
- `--sm-group-num`: задает размер массива decode-backend'ов внимания. Он должен быть **не меньше** фактического числа групп потоков, иначе переключение упрется в `IndexError`.
- `--chunked-prefill-size -1`, `--disable-overlap-schedule`, `--pp-size 1`, `--disaggregation-mode null`: обязательные условия.
- `--speculative-adaptive-config`: адаптивная спекуляция явно отказывается работать с pdmux (`enable_pdmux=True is not supported (adaptive state swap does not update decode_attn_backend_group)`).
- `--enable-two-batch-overlap`: другой способ совмещения; путь захвата графов в pdmux отдельный, комбинировать их не следует.
- `--cuda-graph-bs` / `--cuda-graph-max-bs`: каждый набор размеров захватывается для каждой группы потоков — учитывайте множитель в бюджете VRAM.

## Типовые проблемы и диагностика

- `AssertionError: PD-Multiplexing is not compatible with chunked prefill.` — добавьте `--chunked-prefill-size -1`.
- `AssertionError: PD-Multiplexing is not compatible with overlap schedule.` — добавьте `--disable-overlap-schedule`.
- `AssertionError: PD-Multiplexing is only supported with pipeline parallelism disabled (pp_size=1).` / `... is not compatible with disaggregation mode.` — уберите конфликтующий флаг.
- `ValueError: Unsupported compute capability: X.Y` — карта вне списка архитектур, для которых заданы ограничения green context.
- `ValueError: No valid partitions found for total SMs ... with constraints ...` — карта слишком мала для запрошенного деления; уменьшите `sm_group_num` в конфиге.
- `IndexError` при переключении decode-backend'а — `--sm-group-num` меньше числа групп потоков из конфига.
- OOM на захвате графов — умножьте обычный бюджет графов на число групп потоков; уменьшайте `--cuda-graph-max-bs` или число групп.
- Подтверждение включения — строка `PD-Multiplexing enabled with N stream groups, sm_counts (prefill_sm, decode_sm): [...]` и принятое значение в дампе `server_args=`.
- **В arriero:** флаг живет внутри одного процесса и формально совместим с моделью «один процесс на инстанс» (`process/supervisor.ts`). Но он не входит в квалифицированный профиль KTransformers (`docs/KTRANSFORMERS_OPERATIONS.md`), а его требования (`--disable-overlap-schedule`, `--chunked-prefill-size -1`, torch 2.6.x) расходятся с этим профилем — проверяйте на стенде, прежде чем ставить в инстанс.

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --enable-pdmux --chunked-prefill-size -1 --disable-overlap-schedule --pp-size 1
```

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-32B --enable-pdmux --pdmux-config-path /etc/sglang/pdmux.yaml --sm-group-num 8 --chunked-prefill-size -1 --disable-overlap-schedule --cuda-graph-max-bs 32
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/multiplex/pdmux_context.py`
- `sglang/python/sglang/srt/multiplex/multiplexing_mixin.py`
- `sglang/python/sglang/srt/model_executor/runner/decode_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/attention_backend_setup.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/speculative/adaptive_spec_params.py`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`
