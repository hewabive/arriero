---
schema: 1
engine: sglang
primaryName: "--enable-pd-role-switch"
title: "--enable-pd-role-switch"
summary: Разрешает переключать работающий PD-инстанс между prefill и decode через `POST /pd_role_switch` без перезапуска процесса. Инстанс должен быть полностью простаивающим; DP/EP/PP/DCP и спекулятивное декодирование с флагом несовместимы.
group: disagg
related:
  - --disaggregation-mode
  - --disaggregation-transfer-backend
  - --disaggregation-bootstrap-port
  - --disaggregation-decode-host-receive-threshold
  - --enable-dp-attention
  - --moe-a2a-backend
  - --speculative-algorithm
  - --admin-api-key
---

# --enable-pd-role-switch

## Кратко

В PD-disaggregation роль инстанса (`prefill` или `decode`) обычно фиксирована на старте. С этим флагом ту же копию модели можно перевести в другую роль на ходу запросом `POST /pd_role_switch`: веса и KV-пул остаются на месте, разбираются и пересобираются только роль-специфичные структуры (очереди, буферы метаданных, KV-менеджер передачи). Переключение возможно лишь на простаивающем инстансе, поэтому оркестратор сначала снимает его с маршрутизации и дожидается слива. Флаг новый в checkout'е; наличие в установленной сборке проверяйте по `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
Allow runtime prefill<->decode role switch via /pd_role_switch (PD mode).
```

## Паспорт аргумента

- Флаги: `--enable-pd-role-switch`
- Группа: `disagg`
- Тип значения: bool (флаг без значения)
- Допустимые значения: есть / нет
- Значение по умолчанию: `false`
- Эффективное значение: совпадает с заданным; `handle_pd_disaggregation` (`arg_groups/pd_disaggregation_hook.py`) значение не меняет, но при `--disaggregation-mode prefill|decode` отвергает несовместимые конфигурации
- Где объявлен: `python/sglang/srt/arg_groups/fields/disagg.py:Disagg.enable_pd_role_switch`
- Статус: обычный, opt-in
- Этап применения: `ServerArgs.resolve_once` → `run_resolution_pipeline`, шаг `handle_pd_disaggregation` (проверки) → запуск bootstrap-сервера в tokenizer manager → построение `req_to_token`-пула → цикл scheduler'а (супервизор перезапуска цикла) → HTTP-эндпоинт `/pd_role_switch`

## Что меняет в движке

Даже без единого переключения флаг меняет поведение на старте:

- **Bootstrap-сервер поднимается на любом PD-инстансе**, а не только на prefill (`start_disagg_service`, `managers/disagg_service.py`): при перевороте он не пересоздается, поэтому должен существовать заранее. В лог идет предупреждение `Role switch starts a bootstrap server on this instance at <host>:<port>. If another PD instance runs on the same host, give each one a distinct --disaggregation-bootstrap-port or the bind will conflict.`
- **`req_to_token`-пул строится в decode-форме** и на prefill-инстансе (`_build_req_to_token_pool`, `mem_cache/kv_cache_configurator.py`): число дополнительных слотов берется из `--disaggregation-decode-extra-slots`, а если его нет — `0`.
- Цикл scheduler'а оборачивается супервизором `run_event_loop_supervisor` (`disaggregation/role_switch.py`), который после успешного переключения заново выбирает event loop под новую роль.
- ZMQ-приемники KV-менеджера читают сокеты с таймаутом опроса 500 мс вместо блокирующего `recv` (`_make_worker_recv`, `disaggregation/common/conn.py`), чтобы teardown мог их остановить. Без флага этот путь не включается.
- Метрики scheduler'а получают метку `engine_type="dynamic"` вместо `prefill`/`decode`, чтобы серия не рвалась при перевороте.

Проверки в `handle_pd_disaggregation` (только при `--disaggregation-mode prefill|decode`) отвергают на старте с `ValueError: --enable-pd-role-switch does not rebuild role-specific state for the following features: …`: DP attention, `--ep-size > 1`, `--moe-a2a-backend` не `none`, `--pp-size > 1`, `--dp-size > 1`, `--dcp-size > 1` и любое `--speculative-algorithm`. Отдельно `--disaggregation-decode-host-receive-threshold > 0` несовместим с флагом (`Decode host receive does not yet support HiSparse or role switching`).

Сам переворот (`handle_pd_role_switch`) идет в таком порядке:

1. отказ без изменений состояния, если флаг не задан, инстанс уже помечен unhealthy, другое переключение в процессе, `new_role` не `prefill`/`decode`, инстанс не в PD-режиме, KV-менеджер не поддерживает переключение (в checkout'е `supports_role_switch = True` только у `mooncake` и `mori`) или включен staging-буфер `SGLANG_DISAGG_STAGING_BUFFER`;
2. та же роль — успешный ответ `already in target role`;
3. инстанс не простаивает (есть running/waiting запросы) — отказ `instance is not idle; drain all requests before switching`;
4. при переходе в decode, если decode CUDA graphs еще не захвачены (типично для инстанса, стартовавшего prefill'ом), поле `decode_cuda_graph_memory_gb` в теле запроса обязательно; свободная VRAM сравнивается с ним, и при нехватке — отказ;
5. teardown текущей роли (KV-менеджер, очереди, буферы метаданных) плюс сброс radix/HiCache-дерева, включая best-effort очистку storage-backend'а: префиксы старой роли не переносятся;
6. смена `disaggregation_mode` и `init_disaggregation()` под новую роль;
7. для decode — захват decode CUDA graphs (`decode_cuda_graph_bs` из запроса или серверный список); ошибка захвата не фатальна, decode просто пойдет в eager.

Если шаги 5–6 бросили исключение, отката нет: инстанс помечается unhealthy (`PD role switch (… -> …) failed during teardown/rebuild; instance unhealthy`), и все следующие переключения отвергаются до перезапуска процесса.

## Значения и формат

- Флаг без значения.
- Эндпоинт: `POST /pd_role_switch`, тело `{"new_role": "prefill"|"decode", "decode_cuda_graph_bs": [..], "decode_cuda_graph_memory_gb": N}`; последние два поля опциональны (второе обязательно при первом переходе в decode без захваченных графов).
- Ответ: `{"success", "message", "old_role", "new_role", "safe_to_restore"}`, HTTP 200 при успехе и 400 при отказе. `safe_to_restore: true` означает, что роль-специфичное состояние не тронуто и инстанс можно вернуть в маршрутизацию в старой роли.
- Без флага эндпоинт существует, но отвечает 400 с `--enable-pd-role-switch is not set on this server`.
- В `--disaggregation-mode null` флаг ничего не дает: переключение отвергается (`instance is not running in PD disaggregation mode`), а decode-форма `req_to_token`-пула и метка `dynamic` все равно применяются.

## Когда использовать

- Есть оркестратор (например, `/pd_role_switch` в `sglang_router.mini_lb` из sgl-model-gateway), который перераспределяет пул GPU между prefill и decode под меняющийся профиль нагрузки, и хочется избежать перезагрузки весов.
- Не включайте ради одиночного сервера или статичной PD-пары: флаг меняет форму пулов, поднимает лишний bootstrap-сервер и запрещает DP/EP/спекулятивное декодирование.
- Мини-балансировщик сам снимает воркер с маршрутизации, ждет слива (`drain`, `drain_timeout_secs`, по умолчанию 300 с) и только потом регистрирует его в новой роли. Своему оркестратору придется делать то же самое: движок только отказывает непростаивающему инстансу, сам слив он не организует.

## Влияние на производительность и память

- В штатной работе: decode-форма `req_to_token`-пула на prefill-инстансе (дополнительные слоты — только если задан `--disaggregation-decode-extra-slots`), один лишний bootstrap-сервер в tokenizer manager и опрос ZMQ-сокетов с таймаутом вместо блокирующего чтения.
- Во время переворота инстанс недоступен; при первом переходе в decode добавляется захват CUDA graphs, который требует свободной VRAM (`decode_cuda_graph_memory_gb`) — ее надо оставить заранее, KV-пул повторно не выделяется.
- После переворота prefix-кеш пуст: первые запросы в новой роли идут без попаданий.

## Взаимодействие с другими аргументами

- `--disaggregation-mode`: стартовая роль; переключение работает только из `prefill` и `decode`.
- `--disaggregation-transfer-backend`: только `mooncake` и `mori` объявляют поддержку переключения; с остальными каждый запрос получит отказ (старт при этом проходит).
- `--disaggregation-bootstrap-port`: bootstrap-сервер теперь есть на каждом PD-инстансе, поэтому инстансам на одном хосте нужны разные порты.
- `--disaggregation-decode-host-receive-threshold`: значение `> 0` несовместимо с флагом.
- `--enable-dp-attention`, `--ep-size`, `--moe-a2a-backend`, `--pp-size`, `--dp-size`, `--dcp-size`, `--speculative-algorithm`: любая из этих конфигураций отвергается на старте.
- `--admin-api-key`: эндпоинт помечен `ADMIN_OPTIONAL` — при заданном admin-ключе требует именно его, иначе `--api-key`, а без ключей открыт всем, кто дотягивается до HTTP-порта.

## Типовые проблемы и диагностика

- `ValueError: --enable-pd-role-switch does not rebuild role-specific state for the following features: …` — уберите перечисленные опции или флаг.
- `address already in use` у bootstrap-сервера на decode-инстансе — два PD-инстанса на хосте с одинаковым `--disaggregation-bootstrap-port`; см. предупреждение `Role switch starts a bootstrap server…` в логе.
- Ответ `instance is not idle; drain all requests before switching` (`safe_to_restore: true`) — запросы не слиты; повторите после слива.
- Ответ `decode_cuda_graph_memory_gb is required before capturing decode graphs` или `insufficient decode CUDA graph headroom` — передайте измеренный на decode-соседе объем графов либо освободите VRAM.
- `transfer backend '…' does not support runtime role switch` — смените backend передачи на `mooncake` или `mori`.
- `instance is unhealthy after a failed role switch; restart required` — предыдущий переворот упал посреди пересборки; нужен перезапуск процесса. В checkout'е признак unhealthy блокирует только следующие переключения, на `/health` он не отражается — следите за строкой `failed during teardown/rebuild` в логе.
- Успех подтверждают строки `PD role switch succeeded: prefill -> decode` и `Re-dispatching event loop after PD role switch -> decode`.
- Менеджер инстансов, в том числе arriero, знает роль только по argv запуска: после переворота фактическая роль и сохраненная командная строка расходятся, а перезапуск инстанса вернет стартовую роль.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --port 30000 --disaggregation-mode prefill --disaggregation-transfer-backend mooncake --disaggregation-bootstrap-port 8998 --enable-pd-role-switch
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --port 30001 --disaggregation-mode decode --disaggregation-transfer-backend mooncake --disaggregation-bootstrap-port 8999 --enable-pd-role-switch
```

```bash
curl -X POST http://127.0.0.1:30000/pd_role_switch -H 'Content-Type: application/json' -d '{"new_role": "decode", "decode_cuda_graph_memory_gb": 4}'
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/disagg.py`
- `sglang/python/sglang/srt/arg_groups/pd_disaggregation_hook.py`
- `sglang/python/sglang/srt/disaggregation/role_switch.py`
- `sglang/python/sglang/srt/disaggregation/common/conn.py`
- `sglang/python/sglang/srt/disaggregation/base/conn.py`
- `sglang/python/sglang/srt/disaggregation/mooncake/conn.py`
- `sglang/python/sglang/srt/disaggregation/mori/conn.py`
- `sglang/python/sglang/srt/managers/disagg_service.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/tokenizer_control_mixin.py`
- `sglang/python/sglang/srt/managers/io_struct.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/utils/auth.py`
- `sglang/sgl-model-gateway/bindings/python/src/sglang_router/mini_lb.py`
