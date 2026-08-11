---
schema: 1
engine: sglang
primaryName: "--speculative-use-rejection-sampling"
title: "--speculative-use-rejection-sampling"
summary: Переключает верификацию на классический rejection sampling с настоящим распределением черновика, что делает выход спекуляции распределённо неотличимым от обычного сэмплирования. Работает только для EAGLE/EAGLE3 при `--speculative-eagle-topk 1` и стоит полного тензора вероятностей на каждый шаг черновика.
group: spec
related:
  - --speculative-algorithm
  - --speculative-eagle-topk
  - --speculative-accept-threshold-single
  - --speculative-accept-threshold-acc
  - --enable-deterministic-inference
  - --enable-multi-layer-eagle
  - --speculative-token-map
  - --speculative-num-steps
---

# --speculative-use-rejection-sampling

## Кратко

По умолчанию SGLang верифицирует черновик ядром `tree_speculative_sampling_target_only`: оно смотрит только на распределение target-модели и на пороги принятия. `--speculative-use-rejection-sampling` включает вместо него `chain_speculative_sampling_triton` — классический rejection sampling, которому нужно и распределение черновика. Это даёт математическую гарантию: итоговое распределение выходных токенов совпадает с распределением обычного (неспекулятивного) сэмплирования той же target-модели. Плата — полный тензор вероятностей на каждый шаг черновика в VRAM и жёсткий набор ограничений: только EAGLE/EAGLE3, только линейная цепочка.

## Оригинальная справка

```text
Use rejection sampling for speculative decoding (requires topk=1).
```

## Паспорт аргумента

- Флаги: `--speculative-use-rejection-sampling`
- Группа: `spec`
- Тип значения: bool. Поле объявлено как обычный `bool`, поэтому `add_cli_args_from_dataclass` регистрирует его как `action="store_true"`: флаг без значения, парного `--no-…` нет
- Допустимые значения: наличие флага
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется; вместо этого несовместимая конфигурация приводит к отказу на старте
- Где объявлен: `ServerArgs.speculative_use_rejection_sampling`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `handle_speculative_decoding` → `_handle_eagle_family` (проверки) → инициализация spec-воркера (проверка словарей) → захват draft CUDA graph (дополнительный статический буфер) → forward и верификация

## Что меняет в движке

Три изменения в конвейере черновика (`sglang/python/sglang/srt/speculative/eagle_worker_v2.py`):

1. **Черновик сэмплирует, а не берёт argmax.** В `_draft_extend_*` и в цикле `draft_forward` вместо `fast_topk` используется `sample_draft_proposal` / `fast_sample` — токен-предложение тянется из распределения. Без этого доказательство несмещённости rejection sampling не работает.
2. **Распределение черновика сохраняется.** На каждом шаге в `draft_probs_list` кладётся полный тензор `(bs, vocab_size)` в float32; перед верификацией они собираются в один тензор (`torch.stack(..., dim=1)`) и едут в `EagleVerifyInput.draft_probs`. Без флага туда идёт `None`, а ядро получает `torch.zeros_like(target_probs)`.
3. **Другое ядро верификации.** В `sglang/python/sglang/srt/speculative/eagle_utils.py` выбирается `chain_speculative_sampling_triton` вместо `tree_speculative_sampling_target_only`. Оба получают одни и те же `target_probs` (после temperature/top-k/top-p) и монетки `coins`, но rejection sampling сравнивает `target_probs[t] / draft_probs[t]` с монеткой, а при отказе пересэмплирует из скорректированного остатка.

Проверки в `_handle_eagle_family` (`sglang/python/sglang/srt/arg_groups/speculative_hook.py`) выполняются в момент разбора аргументов и все приводят к отказу старта:

- алгоритм после раскрытия псевдонимов должен быть `EAGLE` или `EAGLE3` (то есть `NEXTN` подходит, а `STANDALONE`, `FROZEN_KV_MTP`, `NGRAM`, `DFLASH` — нет);
- `speculative_eagle_topk` должен быть равен `1`;
- `--speculative-accept-threshold-single` и `--speculative-accept-threshold-acc` должны остаться `1.0` — rejection sampling пороги игнорирует, и молча их не принимает;
- `--enable-deterministic-inference` несовместим: ядро тянет монетки из глобального RNG и не batch-invariant;
- при `--enable-multi-layer-eagle` — снова требование `topk = 1`.

Ещё одна проверка живёт уже в воркере, в `alloc_memory_pool`: словарь черновика должен совпадать со словарём target-модели. Она отсекает связку с `--speculative-token-map` (FR-Spec урезает выходную матрицу черновика). Плюс защита «в глубину» перед самым ядром: если `draft_probs` отсутствует или его последняя размерность не равна словарю, поднимается `ValueError`.

Успешное включение печатает `Rejection sampling is enabled for speculative decoding (speculative_use_rejection_sampling=True).`

## Значения и формат

- Флаг без значения: `--speculative-use-rejection-sampling`. Передать `true`/`false` нельзя — argparse воспримет следующее слово как отдельный аргумент.
- Отсутствие флага означает поведение по умолчанию: верификация только по распределению target-модели, с порогами `--speculative-accept-threshold-single`/`--speculative-accept-threshold-acc`. Этот режим принимает больше токенов, но его выход не совпадает по распределению с обычным сэмплированием.
- При `temperature = 0` (жадная генерация) разницы в выходе быть не должно: оба пути выбирают argmax; разница проявляется на сэмплировании.

## Когда использовать

- Когда важна воспроизводимость семантики сэмплирования: сравнение качества «со спекуляцией и без», оценка на бенчмарках, любые эксперименты, где спекуляция не должна быть источником отличий.
- Когда пороги `--speculative-accept-threshold-*` были подняты «для скорости» и вы хотите вернуться к честной верификации.
- Не включать на продовой конфигурации с широким деревом: флаг требует `topk = 1`, а значит вы теряете дерево целиком.
- Не включать вместе с `--enable-deterministic-inference` — это взаимно исключающие требования.
- Не включать при `--speculative-token-map` — старт упадёт на проверке словарей.

## Влияние на производительность и память

- VRAM: главный расход. На каждый шаг черновика хранится `(bs, vocab_size)` float32. Для батча 48 и словаря 128 256 это ≈ 23.5 МиБ на шаг; при `--speculative-num-steps 3` — около 70 МиБ живых тензоров на каждом decode-шаге.
- VRAM, CUDA graph: `EAGLEDraftCudaGraphRunner` дополнительно выделяет статический буфер `draft_probs` формы `(max_bs, vocab_size)` float32 — ещё ≈ 23.5 МиБ на тех же числах. Он создаётся только при включённом флаге.
- Compute: сэмплирование вместо argmax плюс сохранение полного распределения на шаг; ядро верификации сопоставимо по стоимости с деревянным.
- Acceptance rate обычно **ниже**, чем у режима по умолчанию: rejection sampling отвергает токен с вероятностью `1 − p_target/p_draft` даже там, где target-модель считает его приемлемым. Это цена несмещённости, а не дефект.
- Время старта: чуть дольше из-за дополнительного буфера в графе.
- RAM хоста: не влияет.

## Взаимодействие с другими аргументами

- `--speculative-eagle-topk`: обязан быть `1`.
- `--speculative-algorithm`: только `EAGLE`, `EAGLE3` (и `NEXTN`, который раскрывается в `EAGLE`).
- `--speculative-accept-threshold-single` / `--speculative-accept-threshold-acc`: должны остаться `1.0`; иначе явный `ValueError`.
- `--enable-deterministic-inference`: взаимно исключены.
- `--enable-multi-layer-eagle`: допустим только вместе с `topk = 1`.
- `--speculative-token-map`: взаимно исключены (разные словари черновика и target-модели).
- `--speculative-num-steps`: умножает расход VRAM на распределения черновика.

## Типовые проблемы и диагностика

- `NotImplementedError: --speculative-use-rejection-sampling is only supported for EAGLE / EAGLE3 / NEXTN, not speculative_algorithm=…` — алгоритм не из поддерживаемых.
- `--speculative-use-rejection-sampling requires --speculative-eagle-topk=1` — уберите дерево.
- `--speculative-use-rejection-sampling is incompatible with --speculative-accept-threshold-single / --speculative-accept-threshold-acc` — верните пороги к `1.0` (то есть просто не задавайте их).
- `--speculative-use-rejection-sampling is incompatible with --enable-deterministic-inference` — выберите одно из двух.
- `--speculative-use-rejection-sampling requires the draft and target to share one vocab, but the draft vocab (N) != target vocab (M)` — включён FR-Spec (`--speculative-token-map`) или черновик с урезанным словарём.
- `Rejection sampling requires a target-vocab draft proposal distribution; the current speculative algorithm/draft worker does not produce one` — защита перед ядром; означает, что воркер не отдал `draft_probs`.
- `accept len` упал после включения — ожидаемо; сравнивайте с режимом по умолчанию, а не с «идеалом».
- OOM при большом словаре и большом `--cuda-graph-max-bs-decode` — сработали два тензора `(max_bs, vocab)`; снизьте `--cuda-graph-max-bs-decode` или `--max-running-requests`.
- Чем подтвердить: строка `Rejection sampling is enabled for speculative decoding (speculative_use_rejection_sampling=True).` и дамп `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Meta-Llama-3-8B-Instruct --speculative-algorithm EAGLE3 --speculative-draft-model-path lmsys/sglang-EAGLE3-LLaMA3.1-Instruct-8B --speculative-num-steps 3 --speculative-eagle-topk 1 --speculative-num-draft-tokens 4 --speculative-use-rejection-sampling
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --speculative-algorithm NEXTN --speculative-num-steps 2 --speculative-eagle-topk 1 --speculative-num-draft-tokens 3 --speculative-use-rejection-sampling --max-running-requests 8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/speculative/eagle_worker_v2.py`
- `sglang/python/sglang/srt/speculative/eagle_utils.py`
- `sglang/python/sglang/srt/speculative/eagle_info.py`
- `sglang/python/sglang/srt/speculative/eagle_draft_cuda_graph_runner.py`
- `sglang/python/sglang/srt/speculative/spec_utils.py`
- `sglang/python/sglang/srt/arg_groups/arg_utils.py`
