---
schema: 1
engine: sglang
primaryName: "--enforce-piecewise-cuda-graph"
title: "--enforce-piecewise-cuda-graph"
summary: Устаревший алиас `--cuda-graph-backend-prefill=tc_piecewise`. Слово enforce потеряло смысл — сегодня любое явное значение prefill-backend'а само по себе отключает каскад авто-отключения, а не только это.
group: null
related:
  - --cuda-graph-backend-prefill
  - --cuda-graph-tc-compiler
  - --cuda-graph-config
  - --cuda-graph-bs-prefill
  - --cuda-graph-max-bs-prefill
  - --enable-torch-compile
  - --enable-dp-attention
  - --moe-a2a-backend
  - --enable-lora
  - --enable-hierarchical-cache
  - --pp-size
---

# --enforce-piecewise-cuda-graph

## Кратко

`tc_piecewise` — prefill-backend на базе torch.compile: модель компилируется и режется на куски вокруг внимания, каждый кусок захватывается в CUDA graph. Этот флаг устарел и заменен на `--cuda-graph-backend-prefill tc_piecewise`.

Историческое «enforce» означало: включить piecewise даже там, где движок сам бы его отключил. Сейчас это свойство обобщено — `_parse_cuda_graph_config` помечает любую заданную пару `(фаза, ключ)` как locked, а `_apply_cuda_graph_compatibility` первой же строкой выходит, если заблокирована пара `(prefill, backend)`. То есть каскад авто-отключения пропускается при **любом** явном prefill-backend'е, включая `breakable` и `full`. Именно об этом говорит вторая фраза в подсказке апстрима.

## Оригинальная справка

```text
Deprecated alias for --cuda-graph-backend-prefill=tc_piecewise. Explicitly setting the prefill backend now skips the auto-disable cascade automatically.
```

## Паспорт аргумента

- Флаги: `--enforce-piecewise-cuda-graph`
- Группа: `null` — устаревший алиас объявлен литеральным `parser.add_argument` в `add_cli_args`, вне пофазной группы `exec.graph`
- Тип значения: флаг без значения
- Допустимые значения: только присутствие флага
- Значение по умолчанию: `None` (`DeprecatedStoreConstAction` с `default=None`) — поле остается незаданным
- Эффективное значение: кладет константу `tc_piecewise` в `cuda_graph_backend_prefill` и блокирует пару `(prefill, backend)`. Значение по умолчанию для prefill без всяких флагов — `breakable` на CUDA и `tc_piecewise` на прочих платформах
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`; `dest` — `cuda_graph_backend_prefill`
- Статус: устаревший (`DeprecatedStoreConstAction`), замена — `--cuda-graph-backend-prefill tc_piecewise`
- Этап применения: разбор CLI (предупреждение) → `_handle_cuda_graph_config` → компиляция и захват prefill в `PrefillCudaGraphRunner`

## Что меняет в движке

### Предупреждение и трансляция

```text
'--enforce-piecewise-cuda-graph' is deprecated and will be removed in a future release. Use '--cuda-graph-backend-prefill=tc_piecewise' instead.
```

Печатается на разборе аргументов, до `logging.basicConfig`, поэтому строка стоит в начале вывода без временного префикса.

### Каскад, который пропускается

`_disable_tc_piecewise_cudagraph_if_incompatible` — длинный список правил, каждое из которых отключает prefill-граф. На момент коммита checkout'а туда входят: модель из черного списка архитектур, DP attention, полный `--enable-torch-compile`, `--pp-size > 1`, не-CUDA платформы (HIP/NPU/CPU/MPS/XPU), OOT-платформа без поддержки piecewise, любой MoE a2a-backend кроме `none`, LoRA, мультимодальная модель вне allowlist, GGUF-квантизация, DLLM, `--cpu-offload-gb > 0` или `--enable-hierarchical-cache`, детерминированный вывод, PD-disaggregation, symmetric memory, EPLB или запись распределения экспертов, context parallel (`attn_cp_size > 1`), `--debug-cuda-graph`, DSA prefill context parallel, decode context parallel (`--dcp-size > 1`).

Это не перестраховка, а перечень мест, где dynamo или сам захват ломались. Явно задавая backend, вы берете ответственность за то, что ваша комбинация не входит в список либо была проверена вручную.

Отдельная деталь: при **неявном** backend'е `breakable` и мультимодальной модели из allowlist движок сам переключается на `tc_piecewise`:

```text
Using tc_piecewise CUDA graph for validated multimodal decoder prefill.
```

С явным флагом эта ветка тоже не выполняется.

### Что делает tc_piecewise

`TcPiecewiseCudaGraphBackend` строит `CompilationConfig` из `cuda_graph_config.prefill.bs` (список размеров в токенах) и `cuda_graph_config.prefill.tc_compiler` (`eager` или `inductor`), при DeepEP/Mooncake регистрирует точку разреза на MoE-операции, затем оборачивает `language_model.model.forward` в `torch.compile` и прогоняет по одному forward на каждую форму, чтобы прогреть FX и inductor до собственно захвата графов. Отсюда главная разница с `breakable`: старт дольше на время компиляции, зато возможны слияния ядер.

## Значения и формат

- Булев флаг без значения.
- Взаимно исключающие соседи по тому же полю: `--enable-breakable-cuda-graph` (`breakable`) и `--disable-piecewise-cuda-graph` (`disabled`). При одновременной передаче побеждает разобранный последним.
- Пофазный `--cuda-graph-backend-prefill` перекрывает алиас; JSON `--cuda-graph-config` перекрывает всё.
- Backend `full` для prefill существует, но включается только явно и печатает предупреждение `cuda_graph_config[prefill].backend='full' is experimental. Use breakable or tc_piecewise for production workloads.`
- В YAML через `--config` ключ `cuda-graph-backend-prefill` недоступен — он отвергается из-за этих алиасов на общем `dest`.

## Когда использовать

- Не использовать: пишите `--cuda-graph-backend-prefill tc_piecewise`.
- Сам backend (под новым именем) осмыслен на не-CUDA платформах, где он и так по умолчанию, и в измеренных случаях, когда `inductor` дает выигрыш на prefill конкретной модели.
- Явное значение оправдано, если вы точно знаете, что попадаете под правило каскада, но проверили работоспособность руками. Во всех остальных случаях явное значение — способ получить падение захвата вместо тихого отката на eager.
- Не сочетать с `--enable-torch-compile`: это правило каскада, и не зря — полная компиляция и piecewise-компиляция конфликтуют.

## Влияние на производительность и память

- Время старта: самый дорогой из prefill-backend'ов. Кроме захвата по одной форме добавляется прогон компилятора; с `--cuda-graph-tc-compiler inductor` это могут быть минуты на большой модели.
- VRAM: резерв тот же, что и у прочих prefill-графов (`len(prefill.bs) * 8` МиБ для не-MLA, 1.5 ГиБ для MLA); фактический расход — в `mem usage` строки `Capture target prefill CUDA graph end`.
- Latency prefill: сопоставима с breakable; выигрыш возможен за счет слияний inductor и зависит от модели.
- Decode: не затрагивается, у него своя фаза и свой backend.

## Взаимодействие с другими аргументами

- `--cuda-graph-backend-prefill`: актуальная форма.
- `--cuda-graph-tc-compiler` (устаревший алиас `--piecewise-cuda-graph-compiler`): единственная настройка, специфичная именно для `tc_piecewise`; при других backend'ах игнорируется.
- `--cuda-graph-bs-prefill` / `--cuda-graph-max-bs-prefill`: список и потолок форм в токенах; для `tc_piecewise` это заодно и набор форм для компиляции.
- `--enable-torch-compile`, `--enable-dp-attention`, `--moe-a2a-backend`, `--enable-lora`, `--enable-hierarchical-cache`, `--pp-size > 1`: правила каскада, которые явное значение отменяет.
- `--debug-cuda-graph`: тоже правило каскада; сам по себе он включает разрывы в breakable-графе для пошаговой отладки.

## Типовые проблемы и диагностика

- `'--enforce-piecewise-cuda-graph' is deprecated …` — замените на `--cuda-graph-backend-prefill tc_piecewise`.
- Падение с сообщением про backend prefill (`Fail when using backend: tc_piecewise for prefill runner.` плюс список предложений) — комбинация из каскада, включенная принудительно. Уберите явный backend.
- Старт стал дольше на минуты — работает компилятор; проверьте `--cuda-graph-tc-compiler` и подумайте о `breakable`.
- Ошибки dynamo/torch.compile в трассировке во время старта — прямой признак того, что модель или конфигурация не поддерживает piecewise.
- `Using tc_piecewise CUDA graph for validated multimodal decoder prefill.` — авто-переключение сработало само, флаг не нужен.
- Что смотреть: `cuda_graph_config=` в дампе `server_args=`, строки `Capture target prefill CUDA graph begin/end`, `startup_time.cuda_graph.prefill` в `GET /server_info`.

## Примеры

Актуальная форма вместо этого флага:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-backend-prefill tc_piecewise
```

Piecewise с компилятором inductor и ограниченным набором форм:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-backend-prefill tc_piecewise --cuda-graph-tc-compiler inductor --cuda-graph-max-bs-prefill 2048
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/model_executor/cuda_graph_config.py`
- `sglang/python/sglang/srt/model_executor/runner_backend/tc_piecewise_cuda_graph_backend.py`
- `sglang/python/sglang/srt/model_executor/runner_backend_utils/tc_piecewise_cuda_graph/context_manager.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/docs/docs/advanced_features/piecewise_cuda_graph.mdx` (отстал от кода: описывает устаревшие имена как актуальные)
