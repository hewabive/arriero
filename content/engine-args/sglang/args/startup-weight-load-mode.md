---
schema: 1
engine: sglang
primaryName: "--startup-weight-load-mode"
title: "--startup-weight-load-mode"
summary: Управляет порядком загрузки стартовых весов и захвата CUDA graph. Экспериментальный `overlap` строит модель с capture-safe sentinel, параллельно прогревает checkpoint files и после capture записывает реальные веса без смены tensor storage; поддерживается только узкой allowlist-конфигурацией.
group: model
related:
  - --load-format
  - --dtype
  - --tp-size
  - --disable-cuda-graph
  - --weight-loader-prefetch-num-threads
  - --weight-loader-disable-mmap
  - --weight-loader-drop-cache-after-load
  - --enable-torch-compile
  - --cpu-offload-gb
---

# --startup-weight-load-mode

## Кратко

Обычный `serial` сначала полностью загружает checkpoint, затем создаёт memory pools/backends и захватывает CUDA graphs. `overlap` меняет порядок: аллоцирует конечные parameter storages с безопасным sentinel-значением, запускает background prefetch файлов, захватывает graphs на этих же адресах и только потом записывает реальные веса in-place.

Это ускорение cold start за счёт перекрытия дискового I/O с graph capture. Оно не меняет inference после успешного старта, но имеет намеренно узкий admission gate: неподдерживаемая комбинация падает до serving, а не молча возвращается к serial.

## Оригинальная справка

```text
Control startup weight loading relative to CUDA graph capture. 'serial' preserves the existing startup order; 'overlap' stages checkpoint files while CUDA graphs are captured and commits the real weights afterward.
```

## Паспорт аргумента

- Флаги: `--startup-weight-load-mode`
- Группа: `model`
- Тип значения: enum
- Допустимые значения: `serial`, `overlap`
- Значение по умолчанию: `serial`
- Где объявлен: `ServerArgs.startup_weight_load_mode`
- Этап применения: model loader selection → capture-safe model preparation → checkpoint prefetch параллельно KV/backend/CUDA graph init → in-place weight commit → distributed post-load barrier

## Что меняет в движке

В `overlap` `load_model` создаёт `StartupWeightLoadManager`. `prepare()` инициализирует native model, разрешает единственный checkpoint source и заполняет floating parameters `CAPTURE_SAFE_WEIGHT_SENTINEL`. После создания TP worker scheduler запускает prefetch, затем выделяет KV pools, создаёт attention backends и захватывает CUDA graphs.

`finalize()` фиксирует manifest адресов/shape/stride/dtype всех parameters и buffers, записывает checkpoint в существующие storages, синхронизирует CUDA и проверяет две инварианты: storage не изменился и ни один floating parameter не остался целиком sentinel. Только после этого выполняется post-load barrier и worker считается готовым.

Если background prefetch завершился ошибкой, commit откатывается к обычному чтению checkpoint и пишет warning. Ошибка commit/storage validation терминальна.

## Значения и формат

- `serial` — прежний порядок и максимальная совместимость.
- `overlap` — только CUDA с хотя бы одним включённым CUDA graph phase; prefill backend `tc_piecewise` не поддержан.
- Поддержаны только native `LlamaForCausalLM`, `Qwen2ForCausalLM`, `Qwen3ForCausalLM`, FP16/BF16 generation models, `DefaultModelLoader`, `--load-format auto|safetensors`, TP1/TP2.
- Не поддержаны quantization/ModelOpt, multimodal, draft/speculative decoding, LoRA, torch.compile, CPU/layer-group offload, memory saver/CPU backup, custom loader, secondary weights, disabled mmap или drop-page-cache-after-load.
- CP, DCP, PP, DP и EP должны оставаться равны 1.

## Когда использовать

- Для повторяемого cold start большой Llama/Qwen2/Qwen3 safetensors checkpoint с медленного или холодного storage, когда CUDA graph capture занимает сопоставимое время.
- Сначала измерьте `serial`: на прогретом page cache или маленькой модели background staging может не дать выигрыша.
- Не используйте как общий «ускоритель загрузки» для SGLang-KT/MoE/offload профиля arriero: эти конфигурации не проходят allowlist.
- Оставляйте `serial`, если важнее широкий набор loader/quantization/parallelism возможностей.

## Влияние на производительность и память

VRAM всё равно содержит tensor storages полного размера: overlap меняет их начальное содержимое, а не объём. Он не создаёт вторую GPU-копию весов и обязан сохранить `data_ptr`, чтобы graph captures остались валидны.

Background threads прогревают checkpoint pages и конкурируют за disk bandwidth/host page cache с остальным стартом. Число потоков задаёт `--weight-loader-prefetch-num-threads`. Выигрыш ограничен меньшей из длительностей staging и capture; commit реальных weights после capture остаётся последовательным участком.

## Взаимодействие с другими аргументами

- `--disable-cuda-graph` делает overlap недопустимым: перекрывать нечего.
- `--load-format` допускает только `auto`/`safetensors`; loader должен разрешить ровно один source.
- `--weight-loader-prefetch-num-threads` задаёт parallelism фонового staging.
- `--weight-loader-disable-mmap` и `--weight-loader-drop-cache-after-load` несовместимы с prefetch contract.
- `--tp-size` допустим только 1 или 2; остальные виды parallelism запрещены.
- `--enable-torch-compile`, offload, LoRA, speculative и quantization меняют storage/load lifecycle и поэтому отвергаются.

## Типовые проблемы и диагностика

- `--startup-weight-load-mode=overlap is not supported: <reason>` — admission gate называет конкретное несовместимое свойство; либо уберите его, либо верните `serial`.
- `Startup weight commit changed graph-visible tensor storage` — loader/model заменил parameter/buffer вместо in-place записи; конфигурация не может безопасно использовать уже захваченный graph.
- `Startup weight commit did not replace capture-safe dummy values` — checkpoint не заполнил один из floating parameters; процесс намеренно не начинает serving.
- Успешный путь показывает `Prepared capture-safe model`, `Started checkpoint prefetching` и `Load weight end. Committed real weights after CUDA graph capture ...`; фактическое перекрытие видно в `capture overlap window`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --load-format safetensors --startup-weight-load-mode overlap --weight-loader-prefetch-num-threads 4
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B --startup-weight-load-mode serial
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/startup_weight_load.py`
- `sglang/python/sglang/srt/model_loader/weight_utils.py`
