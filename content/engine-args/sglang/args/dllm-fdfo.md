---
schema: 1
engine: sglang
primaryName: "--dllm-fdfo"
title: "--dllm-fdfo"
summary: Выбирает петлю исполнения диффузионной LLM: по умолчанию один шаг разглаживания за итерацию планировщика с досрочной выдачей готовых блоков (FDFO), а `--no-dllm-fdfo` возвращает синхронную петлю, где блок доводится до конца внутри одного вызова.
group: exec.dllm
related:
  - --dllm-algorithm
  - --dllm-algorithm-config
  - --max-running-requests
  - --disable-radix-cache
  - --page-size
---

# --dllm-fdfo

## Кратко

Блок диффузионной модели разглаживается за несколько forward'ов. Вопрос в том, где крутится эта петля. При синхронном режиме она крутится внутри одного вызова модели: батч фиксирован, и пока самый «трудный» блок не разгладится, ни один запрос батча не сдвинется. При FDFO (First-Done-First-Out) на каждую итерацию планировщика выполняется ровно один шаг, состояние алгоритма переносится между итерациями, а запросы, чей блок готов, выходят немедленно.

Флаг объявлен через `argparse.BooleanOptionalAction` и включен по умолчанию, поэтому реально задают его парную форму — `--no-dllm-fdfo`.

## Оригинальная справка

```text
Enable First-Done-First-Out (FDFO) scheduling for diffusion LLM inference. Enabled by default; use --no-dllm-fdfo to fall back to synchronous block scheduling.
```

## Паспорт аргумента

- Флаги: `--dllm-fdfo`, `--no-dllm-fdfo`
- Группа: `exec.dllm`
- Тип значения: bool
- Значение по умолчанию: `true` — FDFO включен; «не задан» означает включенный FDFO
- Эффективное значение: совпадает с заданным; переопределений нет
- Где объявлен: `ServerArgs.dllm_fdfo`, файл — `sglang/python/sglang/srt/server_args.py`; `action` — `argparse.BooleanOptionalAction`
- Статус: обычный
- Этап применения: инициализация scheduler'а (`DllmConfig.first_done_first_out_mode`) → каждая итерация обработки батча

## Что меняет в движке

`DllmAlgorithm.run` (`sglang/python/sglang/srt/dllm/algorithm/base.py`) выбирает одну из двух реализаций.

### Синхронная петля (`--no-dllm-fdfo`)

```python
out = model_runner.forward(forward_batch, ...)
states = self.init_step_state(forward_batch)
for _ in range(self.max_steps(self.block_size)):
    done = self.step(forward_batch, out.logits_output.full_logits, states)
    if all(done):
        break
    out = model_runner.forward(forward_batch, ...)
```

Число шагов ограничено `max_steps`: `block_size + 1` для `LowConfidence` и `block_size + max_post_edit_steps + 1` для `JointThreshold`. Выход из петли — только когда завершены **все** блоки батча. На NPU метаданные внимания помечаются готовыми после первого forward'а, чтобы последующие шаги не перепланировались.

### FDFO (по умолчанию)

Выполняется один forward и один `step`; на выход отдаются `accept_length_per_req_cpu` (равно `block_size` для готовых блоков и `0` для незавершенных) и состояния алгоритма для переноса. Обработчик результата (`sglang/python/sglang/srt/dllm/mixin/scheduler.py`) для незавершенных блоков сохраняет частичные токены в `req.dllm_incomplete_ids` и состояние в `req.dllm_algo_state`, а для завершенных записывает раскрытый блок в committed fill ids — чтобы префиксный кеш ключевался по реальным токенам, а не по маске.

Практическая разница: при FDFO запрос, чей блок готов за 3 шага, не ждет соседа, которому нужно 30. Кроме того, KV незавершенных блоков коммитится и переиспользуется в следующем раунде.

## Значения и формат

- `--dllm-fdfo` — включить явно (совпадает с поведением по умолчанию); `--no-dllm-fdfo` — синхронный режим.
- Не задан — FDFO включен.
- Без `--dllm-algorithm` значение не читается: `DllmConfig` не создается.
- Режим влияет и на алгоритм: у `JointThreshold` общее батчевое состояние (`vectorized_decoding`) используется только в синхронной петле; при FDFO состояние собирается и раскладывается по запросам каждый раунд.

## Когда использовать

- Оставлять FDFO включенным на любой конкурентной нагрузке: он и есть причина, по которой режим по умолчанию именно такой.
- Переключаться на `--no-dllm-fdfo` при отладке алгоритма или при воспроизведении чужих замеров: синхронная петля проще и не переносит состояние между итерациями.
- `--no-dllm-fdfo` имеет смысл на однопоточной нагрузке (`--max-running-requests 1`), где переносить состояние между итерациями не нужно, а лишние проходы планировщика — накладные расходы.
- Не ожидать от переключения выигрыша в качестве: правило раскрытия одно и то же, отличается только место, где крутится цикл.

## Влияние на производительность и память

- VRAM: не влияет напрямую. Косвенно FDFO дольше удерживает KV незавершенных блоков (они коммитятся ради переиспользования), синхронный режим освобождает их после завершения блока.
- RAM хоста: FDFO хранит состояние алгоритма на запрос между итерациями; объем невелик (у `JointThreshold` — маска промпта и счетчик правок).
- Время старта: не влияет.
- Latency: главный эффект. При синхронном режиме время выдачи блока определяет самый медленный блок батча; при FDFO — собственный блок запроса.
- Throughput: FDFO лучше на разнородной нагрузке (запросы с разной «трудностью» блоков) и примерно эквивалентен на однородной.

## Взаимодействие с другими аргументами

- `--dllm-algorithm`: единственный флаг, при котором значение читается.
- `--dllm-algorithm-config`: `max_post_edit_steps` у `JointThreshold` входит в потолок числа шагов синхронной петли; `vectorized_decoding` используется как общее батчевое состояние только в синхронном режиме.
- `--max-running-requests`: при незаданном значении конфиг диффузии подставляет `1`, и разница между режимами почти исчезает.
- `--disable-radix-cache`: FDFO специально коммитит раскрытые блоки, чтобы кеш ключевался по реальным токенам; при отключенном кеше этот выигрыш пропадает.
- `--page-size`: приравнен к размеру блока в обоих режимах.

## Типовые проблемы и диагностика

- `AssertionError: FDFO dLLM result is missing accept lengths.` — внутренняя инвариантная проверка обработчика результата; возникает, если путь исполнения вернул результат не того режима.
- Первый токен ответа приходит с большой задержкой на конкурентной нагрузке — вероятно, задан `--no-dllm-fdfo`, и блок ждет соседей по батчу.
- Ответы одинаковы в обоих режимах — так и должно быть: правило раскрытия не меняется.
- Что смотреть: `dllm_fdfo=` в итоговом дампе `server_args=`; отдельной строки о выбранной петле движок не печатает.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/LLaDA2.0-mini-preview --dllm-algorithm LowConfidence --dllm-fdfo
```

```bash
python -m sglang.launch_server --model-path /models/LLaDA2.0-mini-preview --dllm-algorithm LowConfidence --no-dllm-fdfo --max-running-requests 1
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/dllm/algorithm/base.py`
- `sglang/python/sglang/srt/dllm/mixin/scheduler.py`
- `sglang/python/sglang/srt/dllm/config.py`
- `sglang/python/sglang/srt/dllm/algorithm/joint_threshold.py`
