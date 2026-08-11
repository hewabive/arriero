---
schema: 1
engine: vllm
primaryName: "--shutdown-timeout"
title: "--shutdown-timeout"
summary: Переключает остановку по SIGTERM между режимом abort (0, дефолт — активные запросы обрываются) и drain (N секунд на дожатие уже начатых генераций). Прямо определяет, увидит ли клиент `finish_reason=abort` при рестарте сервера.
group: null
related:
  - --api-server-count
  - --headless
  - --max-num-seqs
  - --max-model-len
---

# --shutdown-timeout

## Кратко

`--shutdown-timeout` задает единственную развилку в поведении при остановке. При `0` (дефолт) движок по SIGTERM немедленно обрывает все незавершенные запросы: клиенты получают ответ с `finish_reason=abort`, а не досчитанный текст. При значении больше нуля движок переходит в режим drain — новые запросы отклоняются, а уже начатые доводятся до конца, и родительский процесс дает на это указанное число секунд, прежде чем убить движок принудительно.

Это не таймаут запроса и не graceful-timeout HTTP-сервера: он влияет только на путь остановки.

## Оригинальная справка

```text
Shutdown timeout in seconds. 0 = abort, >0 = wait.
```

## Паспорт аргумента

- Флаги: `--shutdown-timeout`
- Группа argparse: без группы (объявлен напрямую в `EngineArgs.add_cli_args`)
- Тип значения: int, единица измерения — секунды
- Допустимые значения: `>= 0` (валидация `Field(default=0, ge=0)` в `VllmConfig`)
- Значение по умолчанию: `0` — режим abort
- Эффективное значение: на CUDA не переопределяется; на платформе XPU нулевое значение принудительно заменяется на `5` с сообщением `XPU platform: set server shutdown_timeout=5.`
- Где объявлен: `vllm/engine/arg_utils.py:add_cli_args` (поле — `vllm/config/vllm.py:VllmConfig.shutdown_timeout`)
- Этап применения: обработка SIGTERM/SIGINT — во фронтенде (`vllm/entrypoints/launcher.py`), в `EngineCore` и в менеджерах дочерних процессов

## Что меняет в движке

Значение читается тремя независимыми потребителями.

1. **API-сервер.** `handle_shutdown` в `vllm/entrypoints/launcher.py` по сигналу берет `engine_client.vllm_config.shutdown_timeout`, печатает `[shutdown] API server: stopping engine client mode=<abort|drain> timeout=<N>s` и вызывает `engine_client.shutdown(timeout=...)`. Только после возврата из него останавливается uvicorn.
2. **`EngineCore`.** Обработчик сигнала переводит состояние в `REQUESTED` (`[shutdown] EngineCore: trigger received signal=SIGTERM`), а `_handle_shutdown()` в начале каждой итерации busy-loop выбирает режим: `mode = "abort" if shutdown_timeout == 0 else "drain"`. При abort вызывается `finish_requests(None, FINISHED_ABORTED)` для всех незавершенных запросов и клиентам уходят abort-выводы (`[shutdown] EngineCore: aborting in-flight requests count=N`). При drain движок просто продолжает крутить цикл, пока `has_work()` истинно (`[shutdown] EngineCore: draining in-flight requests count=N timeout=Ns`). В обоих случаях новые запросы с этого момента отклоняются abort-выводом.
3. **Менеджеры процессов.** `shutdown(procs, timeout)` (`vllm/v1/utils.py`) шлет SIGTERM каждому процессу, ждет их `join` суммарно не дольше `timeout`, после чего оставшиеся получают SIGKILL с предупреждением `[shutdown] Process manager: force killing remaining processes count=N`. Если таймаут не задан (внутренние пути очистки), используется запасные 5 секунд.

Существенная деталь: **у самого drain внутреннего дедлайна нет**. `_handle_shutdown()` не проверяет часы — он просто не завершает цикл, пока есть работа. Ограничивает время именно внешний `join(timeout)` с последующим SIGKILL. Поэтому значение аргумента следует читать как «сколько секунд родитель готов ждать, прежде чем убить движок», а не как «через сколько секунд движок сам прервет генерацию».

Тот же таймаут используют `run_headless` и `run_multi_api_server` при остановке (`Waiting up to N seconds for processes to exit`), а DP-супервизор добавляет к нему собственную константу `CHILD_EXIT_GRACE_S`.

## Значения и формат

- Целое число секунд. Суффиксы не поддерживаются.
- `0` — abort. Это дефолт, и именно он объясняет обрыв активных генераций при обычном рестарте.
- Любое положительное значение — drain. Разумный ориентир — время, за которое успевает досчитаться типичный незавершенный ответ; верхняя граница по смыслу — `--max-model-len` токенов на текущей скорости генерации.
- Отрицательные значения отвергаются валидацией `ge=0`.
- Значение `None`/`auto` не поддерживается.

## Когда использовать

- Задавайте положительным, если рестарт сервера не должен рвать активные ответы: обновление модели, плановый перезапуск, обновление окружения.
- Оставляйте `0`, если важнее скорость освобождения VRAM: при abort карта освобождается сразу, при drain — только после последнего запроса или после SIGKILL.
- Согласуйте значение с таймаутом остановки в arriero. Супервизор шлет SIGTERM всей process group и через свой таймаут добивает SIGKILL: 10 секунд по умолчанию для операторской остановки и `ARRIERO_SHUTDOWN_TIMEOUT_MS` (тоже 10 000 мс по умолчанию) при выходе менеджера. `--shutdown-timeout 60` при таком раскладе бесполезен — процесс будет убит на десятой секунде, а drain не успеет.
- Не рассчитывайте на drain при аварийной остановке: SIGKILL обработчиков не имеет.

## Влияние на производительность и память

- На пропускную способность и латентность в установившемся режиме не влияет — код читается только на пути остановки.
- **VRAM.** При drain карта остается занятой до завершения последнего запроса (или до SIGKILL). Для сценариев, где освободившуюся память сразу забирает другой инстанс, это прямая задержка.
- **Время остановки.** Растет ровно на время дожатия активных запросов, ограниченное значением аргумента.

## Взаимодействие с другими аргументами

- `--api-server-count`: при нескольких фронтендах остановку координирует родительский процесс, и тот же таймаут применяется к группе процессов API-серверов и ядер движка.
- `--headless`: в headless-режиме таймаут используется при остановке `CoreEngineProcManager` — строка `Waiting up to N seconds for processes to exit`.
- `--max-num-seqs`: сколько запросов придется дожимать в режиме drain; чем больше одновременных последовательностей, тем дольше окно.
- `--max-model-len`: верхняя граница длины незавершенного ответа и, следовательно, худшего случая drain.

## Типовые проблемы и диагностика

- **Симптом:** при рестарте сервера клиенты получают оборванный ответ с `finish_reason=abort`. **Причина:** дефолтный режим abort. **Проверка:** строки `[shutdown] API server: stopping engine client mode=abort timeout=0s` и `[shutdown] EngineCore: aborting in-flight requests count=N`. **Лечение:** задать положительный `--shutdown-timeout` и поднять таймаут остановки на стороне arriero.
- **Симптом:** задан большой таймаут, но процесс все равно умирает раньше. **Причина:** внешний убийца — либо `[shutdown] Process manager: force killing remaining processes`, либо SIGKILL от arriero по своему таймауту. **Лечение:** согласовать оба значения.
- **Симптом:** остановка «висит». **Причина:** drain ждет длинную генерацию; внутреннего дедлайна у него нет. **Проверка:** `[shutdown] EngineCore: draining in-flight requests count=N timeout=Ns` и отсутствие последующего `request processing complete`. **Лечение:** уменьшить таймаут или вернуть abort.
- **Симптом (XPU):** значение 0 не дает abort. **Причина:** платформенный хук поднимает его до 5. **Проверка:** `XPU platform: set server shutdown_timeout=5.`
- **Подтверждение принятого значения:** пара строк `[shutdown] API server: stopping engine client mode=... timeout=...s` и `[shutdown] EngineCore: start mode=... timeout=...s`.
- **Симптом (arriero):** после остановки инстанса VRAM освобождается не сразу. **Причина:** drain держит карту до конца активных запросов. **Проверка:** отслеживайте статус инстанса `stopping` и событие `force killing` в логе менеджера.

## Примеры

```bash
vllm serve /models/Qwen3-4B --shutdown-timeout 20 --max-num-seqs 8
```

```bash
vllm serve /models/Qwen3-4B --shutdown-timeout 0 --max-model-len 8192
```

## Источники

- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/entrypoints/launcher.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/entrypoints/cli/serve.py`
- `vllm/vllm/v1/engine/core.py`
- `vllm/vllm/v1/engine/core_client.py`
- `vllm/vllm/v1/utils.py`
- `vllm/vllm/platforms/xpu.py`
- `docs/VLLM_OPERATIONS.md` (arriero)
