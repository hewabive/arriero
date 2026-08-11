---
schema: 1
engine: sglang
primaryName: "--enable-single-batch-overlap"
title: "--enable-single-batch-overlap"
summary: Перекрывает вычисление и коммуникацию внутри одного микробатча через хуки вокруг dispatch/combine MoE — например, считает shared-эксперта во время обмена. Падает на старте на SM90 с актуальным sgl-deep-gemm.
group: exec.overlap
related:
  - --enable-two-batch-overlap
  - --tbo-token-distribution-threshold
  - --moe-a2a-backend
  - --moe-runner-backend
  - --deepep-mode
  - --disable-shared-experts-fusion
  - --enforce-shared-experts-fusion
  - --enable-dp-attention
---

# --enable-single-batch-overlap

## Кратко

Single-batch overlap (SBO) — вторая, независимая от TBO схема перекрытия. Она не делит батч, а вставляет хуки до и после операций `dispatch` и `combine` MoE-слоя, чтобы во время обмена выполнялась полезная работа: вычисление shared-эксперта, down-GEMM и подобное. Флаг не требует двух микробатчей и потому применим там, где TBO не подходит.

Практическое ограничение, о котором нужно знать заранее: на SM90 (Hopper) с актуальным колесом `sgl-deep-gemm` режим отвергается прямо на старте с прямой рекомендацией убрать флаг.

## Оригинальная справка

```text
Let computation and communication overlap within one micro batch.
```

## Паспорт аргумента

- Флаги: `--enable-single-batch-overlap`
- Группа: `exec.overlap`
- Тип значения: bool (флаг без значения)
- Значение по умолчанию: `false`
- Эффективное значение: совпадает с заданным; включается только вручную
- Где объявлен: `ServerArgs.enable_single_batch_overlap`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: инициализация MoE-конфигурации (`initialize_moe_config` — там же проверка SM90) → построение MoE-слоев модели → каждый forward

## Что меняет в движке

Значение попадает в глобальный флаг `moe.sbo_enabled` (`sglang/python/sglang/srt/layers/moe/utils.py`), и дальше `SboFlags` (`sglang/python/sglang/srt/batch_overlap/single_batch_overlap.py`) раскладывает его на конкретные перекрытия:

- `enable_combine_down_gemm_two_stream_overlap` — перекрытие down-GEMM с combine; поддерживается на runner backend `flashinfer_cutedsl` и на `deep_gemm` вне Blackwell;
- `enable_dispatch_shared_one_stream_overlap` — вычисление shared-эксперта в одном потоке с dispatch; включается вне Blackwell;
- `enable_combine_shared_two_stream_overlap` — вычисление shared-эксперта во втором потоке параллельно с combine; на Blackwell отключается переменной окружения `SGLANG_BLACKWELL_OVERLAP_SHARED_EXPERTS_OUTSIDE_SBO`;
- `fuse_shared_experts_inside_sbo` — производный признак: когда истинен, shared-эксперты считаются внутри SBO, и модель (`deepseek_v2.py`) перестает фьюзить их обычным образом.

Проверка на старте:

```text
SBO (single batch overlap) is not supported on SM90 GPUs with latest sgl-deep-gemm wheel. Please try removing --enable-single-batch-overlap argument.
```

Она выполняется в `initialize_moe_config` только на CUDA и только при `torch.cuda.get_device_capability()[0] == 9`.

Реализация опирается на систему хуков диспетчера MoE, добавленную в апстриме отдельным PR (ссылка есть в документации по экспертному параллелизму); хуки выполняются вокруг `dispatch`/`combine` без правки самих MoE-модулей.

## Значения и формат

- Флаг без значения; парной формы нет.
- Не задан — обычный последовательный путь MoE.
- Осмысленен только для MoE-моделей с shared-экспертами и с реальной коммуникацией в MoE-слое (то есть с экспертным параллелизмом или DeepEP). На плотной модели перекрывать нечего.
- Флаг влияет и на фьюзинг shared-экспертов: при активных перекрытиях модель считает их внутри SBO, а не сливает с обычными.

## Когда использовать

- На MoE-развертываниях с DeepEP, где shared-эксперт есть и коммуникация заметна в профиле шага — типично для DeepSeek-подобных моделей.
- Вместе с `--enable-two-batch-overlap` на больших EP: механизмы независимы и складываются.
- Не включать на Hopper: старт откажет.
- Не включать на однокарточном хосте без экспертного параллелизма: перекрывать нечего, а поведение фьюзинга shared-экспертов изменится.
- Не рассчитывать на эффект с MoE runner backend'ами вне списка поддержки: часть перекрытий просто не активируется (`enable_combine_down_gemm_two_stream_overlap` проверяет backend явно).

## Влияние на производительность и память

- VRAM: дополнительные потоки и события требуют собственных промежуточных буферов (`CombineOverlapArgs`, `DownGemmOverlapArgs`), но это малые величины относительно активаций MoE.
- RAM хоста: не влияет.
- Время старта: не меняет заметно.
- Throughput: цель флага — сократить время MoE-слоя за счет совмещения обмена с вычислением; выигрыш пропорционален доле коммуникации в шаге.
- Latency: улучшается там же, где и throughput; на нагрузке без коммуникации в MoE-слое эффекта нет.
- Занятость SM: перекрытия используют второй поток и делят SM с основным вычислением (`num_sms` в аргументах перекрытия), поэтому на маленьких батчах возможна деградация.

## Взаимодействие с другими аргументами

- `--enable-two-batch-overlap`: независимый механизм; флаги совместимы.
- `--moe-a2a-backend` / `--deepep-mode`: определяют, какая именно коммуникация перекрывается.
- `--moe-runner-backend`: `flashinfer_cutedsl` и `deep_gemm` (вне Blackwell) включают перекрытие down-GEMM с combine; на прочих backend'ах эта часть не активируется.
- `--disable-shared-experts-fusion` / `--enforce-shared-experts-fusion`: SBO сам решает, считать ли shared-экспертов внутри перекрытия, и при активном перекрытии обычный фьюзинг не применяется.
- `--enable-dp-attention`: типичный спутник крупных EP-развертываний, где SBO и применяется.
- `--tbo-token-distribution-threshold`: относится к TBO, на SBO не влияет.

## Типовые проблемы и диагностика

- `ValueError: SBO (single batch overlap) is not supported on SM90 GPUs with latest sgl-deep-gemm wheel. Please try removing --enable-single-batch-overlap argument.` — единственная жесткая проверка флага.
- Флаг включен, прироста нет — проверьте MoE runner backend: часть перекрытий привязана к `flashinfer_cutedsl`/`deep_gemm`, а на Blackwell перекрытие shared-эксперта может быть выведено наружу переменной окружения `SGLANG_BLACKWELL_OVERLAP_SHARED_EXPERTS_OUTSIDE_SBO`.
- Изменилось поведение shared-экспертов (например, пропала строка о фьюзинге) — это ожидаемое следствие: при активном SBO они считаются внутри перекрытия.
- Деградация на малых батчах — второй поток отбирает SM у основного вычисления.
- Что смотреть: `enable_single_batch_overlap=true` в дампе `server_args=`; отдельной строки о включенных перекрытиях движок не печатает, поведение видно только в профиле.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tp-size 8 --enable-single-batch-overlap --moe-a2a-backend deepep
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tp-size 8 --enable-single-batch-overlap --enable-two-batch-overlap --moe-a2a-backend deepep
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/moe/utils.py`
- `sglang/python/sglang/srt/batch_overlap/single_batch_overlap.py`
- `sglang/python/sglang/srt/models/deepseek_v2.py`
- `sglang/docs/docs/advanced_features/expert_parallelism.mdx`
