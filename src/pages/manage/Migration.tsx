import { Box, Button, Flex, Heading, Text, VStack } from "@hope-ui/solid"
import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { MustAdmin } from "~/app/MustAdmin"
import { useManageTitle } from "~/hooks"
import { Resp } from "~/types"
import { handleRespWithoutNotify, r } from "~/utils"

type Storage = {
  id: number
  mount_path: string
  driver: string
  disabled: boolean
}
type Migration = {
  mode?: "stopped" | "incremental"
  final_freeze_millis?: number
  delta_copied_files?: number
  final_freeze_started_at?: string
  id: string
  source_mount_path: string
  target_mount_path: string
  target_prefix: string
  phase: string
  failed_phase: string
  error_code: string
  error_detail: string
  write_release_committed: boolean
}
type MigrationFile = {
  path: string
  is_dir: boolean
  size: number
  phase: string
  attempts: number
  error_code: string
  error_detail: string
}
type Detail = { migration: Migration; files: MigrationFile[] }
const phases: Record<string, string> = {
  preparing: "准备",
  freezing: "暂停写入",
  draining: "等待在途操作",
  inventory: "建立清单",
  copying: "复制",
  verifying: "校验",
  reconciling: "最终增量核对",
  switching: "切换挂载",
  validating: "验证入口",
  completed_retained: "迁移完成 · 源文件保留",
  failed: "失败 · 等待处理",
  canceled: "已取消",
}
const phaseName = (phase: string) => phases[phase] || phase
const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(2)} MiB`

// 仅展示错误码与脱敏消息，避免泄漏请求配置、签名 URL 和凭据。
const safeFailure = (error: unknown, fallback: string) => {
  const value = error as { code?: unknown; message?: unknown } | null
  const code =
    typeof value?.code === "string" || typeof value?.code === "number"
      ? String(value.code)
      : "NETWORK_ERROR"
  const message = typeof value?.message === "string" ? value.message : fallback
  const redact = (text: string) =>
    text
      .replace(/https?:\/\/[^\s]+/gi, "[链接已隐藏]")
      .replace(
        /(authorization|token|password|secret|signature|access[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
        "$1=[已隐藏]",
      )
  return `${redact(code)} · ${redact(message).slice(0, 600)}`
}

const MigrationContent = () => {
  useManageTitle("manage.sidemenu.migration")
  const [storages, setStorages] = createSignal<Storage[]>([])
  const [rows, setRows] = createSignal<Migration[]>([])
  const [selected, setSelected] = createSignal("")
  const [detail, setDetail] = createSignal<Detail>()
  const [mode, setMode] = createSignal<"stopped" | "incremental">("stopped")
  const [source, setSource] = createSignal("")
  const [target, setTarget] = createSignal("")
  const [confirmed, setConfirmed] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  let disposed = false
  let detailVersion = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const files = () => detail()?.files || []
  const regularFiles = createMemo(() => files().filter((file) => !file.is_dir))
  const verified = createMemo(() =>
    regularFiles().filter((file) => file.phase === "verified"),
  )
  const copiedBytes = createMemo(() =>
    regularFiles()
      .filter((file) => ["copied", "verified"].includes(file.phase))
      .reduce((sum, file) => sum + file.size, 0),
  )
  const failures = createMemo(() =>
    files().filter((file) => file.error_code || file.error_detail),
  )
  const canCancel = () => {
    const migration = detail()?.migration
    const cancellable = [
      "preparing",
      "freezing",
      "draining",
      "inventory",
      "copying",
      "verifying",
      "reconciling",
    ]
    return (
      migration &&
      !migration.write_release_committed &&
      (cancellable.includes(migration.phase) ||
        (migration.phase === "failed" &&
          cancellable.includes(migration.failed_phase)))
    )
  }
  const accept = <T,>(response: Resp<T>, success: (data: T) => void) => {
    if (disposed) return
    handleRespWithoutNotify(response, success, (message, code) =>
      setError(safeFailure({ code, message }, "请求失败")),
    )
  }
  const loadDetail = async (id: string) => {
    const version = ++detailVersion
    const response = await r.get<never, Resp<Detail>>("/admin/migration/info", {
      params: { id },
    })
    if (version !== detailVersion || selected() !== id) return
    accept(response, setDetail)
  }
  const refresh = async () => {
    if (loading() || disposed) return
    setLoading(true)
    try {
      const [list, storageList] = await Promise.all([
        r.get<never, Resp<Migration[]>>("/admin/migration/list"),
        r.get<never, Resp<Storage[]>>("/admin/migration/storages"),
      ])
      accept(list, (data) => setRows(data || []))
      accept(storageList, (data) => setStorages(data || []))
      if (selected()) await loadDetail(selected())
    } catch (cause) {
      if (!disposed)
        setError(safeFailure(cause, "刷新失败，请检查连接后手动刷新。"))
    } finally {
      if (!disposed) setLoading(false)
    }
  }
  const choose = async (id: string) => {
    setSelected(id)
    setDetail(undefined)
    try {
      await loadDetail(id)
    } catch (cause) {
      if (!disposed) setError(safeFailure(cause, "无法读取迁移详情。"))
    }
  }
  const mutate = async (action: "start" | "retry" | "cancel") => {
    if (busy()) return
    const id = selected()
    if (
      action === "cancel" &&
      !window.confirm("取消迁移并解除迁移写入限制？目标已复制的数据将保留。")
    )
      return
    setBusy(true)
    setError("")
    try {
      const response = await r.post<never, Resp<Migration | null>>(
        `/admin/migration/${action}`,
        action === "start"
          ? {
              mode: mode(),
              source_id: Number(source()),
              target_id: Number(target()),
              confirm_exclusive: confirmed(),
            }
          : { id },
      )
      if (disposed) return
      if (response.data?.id) {
        setSelected(response.data.id)
        setDetail(undefined)
        detailVersion++
      }
      accept(response, () => {
        if (action === "start") setConfirmed(false)
      })
      await refresh()
    } catch (cause) {
      if (!disposed)
        setError(
          `${safeFailure(cause, "请求失败")}。操作结果尚未确认，请刷新任务状态后再决定是否重试。`,
        )
    } finally {
      if (!disposed) setBusy(false)
    }
  }
  onMount(() => {
    const poll = async () => {
      if (!document.hidden) await refresh()
      if (!disposed) timer = setTimeout(poll, 5000)
    }
    void poll()
  })
  onCleanup(() => {
    disposed = true
    detailVersion++
    clearTimeout(timer)
  })
  return (
    <VStack alignItems="stretch" spacing="$5" w="$full" p="$4">
      <Flex
        justifyContent="space-between"
        alignItems="center"
        gap="$3"
        flexWrap="wrap"
      >
        <Box>
          <Heading size="xl">存储迁移</Heading>
          <Text color="$neutral11">
            迁移后继续使用原文件路径，下载入口自动解析到目标存储。
          </Text>
        </Box>
        <Button
          onClick={() => {
            setError("")
            void refresh()
          }}
          disabled={loading()}
        >
          刷新状态
        </Button>
      </Flex>
      <Show when={error()}>
        <Box
          role="alert"
          p="$3"
          borderWidth="1px"
          borderColor="$danger7"
          borderRadius="$md"
        >
          <Text color="$danger11">{error()}</Text>
        </Box>
      </Show>
      <Box p="$4" borderWidth="1px" borderRadius="$lg">
        <Heading size="lg" mb="$3">
          发起迁移
        </Heading>
        <Text mb="$3">
          当前仅开放 S3
          驱动，采用单实例、整挂载迁移。请先完成或取消文件任务，并清除普通任务历史。
        </Text>
        <Box mb="$3">
          <label for="migration-mode">迁移方式</label>
          <select
            id="migration-mode"
            value={mode()}
            disabled={busy()}
            onChange={(event) => {
              setMode(event.currentTarget.value as "stopped" | "incremental")
              setConfirmed(false)
            }}
            style={{
              width: "100%",
              padding: "10px",
              "border-radius": "6px",
              color: "inherit",
              background: "transparent",
              border: "1px solid currentColor",
            }}
          >
            <option value="stopped">停写迁移 · 已有基线</option>
            <option value="incremental">增量迁移 · 原型</option>
          </select>
        </Box>
        <Text mb="$3">
          {mode() === "incremental"
            ? "复制期间源存储可继续通过文件服务读写，目标存储保留给迁移使用。最后仅冻结源和目标存储，执行全量枚举、增量补复制和哈希校验，其他挂载继续写入。最终停写可能很长，原型不承诺短暂停写。"
            : "迁移期间暂停整个服务的写入。复制和全量校验会产生读取流量，停写时间随数据量增加。"}
        </Text>
        <Flex gap="$4" flexWrap="wrap">
          <Box flex="1" minW="200px">
            <label for="migration-source">源存储</label>
            <select
              id="migration-source"
              value={source()}
              onChange={(event) => {
                setSource(event.currentTarget.value)
                setConfirmed(false)
              }}
              disabled={busy()}
              style={{
                width: "100%",
                padding: "10px",
                "border-radius": "6px",
                color: "inherit",
                background: "transparent",
                border: "1px solid currentColor",
              }}
            >
              <option value="">选择源存储</option>
              <For
                each={storages().filter(
                  (storage) => !storage.disabled && storage.driver === "S3",
                )}
              >
                {(storage) => (
                  <option value={storage.id}>
                    {storage.mount_path} · {storage.driver}
                  </option>
                )}
              </For>
            </select>
          </Box>
          <Box flex="1" minW="200px">
            <label for="migration-target">目标存储</label>
            <select
              id="migration-target"
              value={target()}
              onChange={(event) => {
                setTarget(event.currentTarget.value)
                setConfirmed(false)
              }}
              disabled={busy()}
              style={{
                width: "100%",
                padding: "10px",
                "border-radius": "6px",
                color: "inherit",
                background: "transparent",
                border: "1px solid currentColor",
              }}
            >
              <option value="">选择目标存储</option>
              <For
                each={storages().filter(
                  (storage) =>
                    !storage.disabled &&
                    storage.driver === "S3" &&
                    String(storage.id) !== source(),
                )}
              >
                {(storage) => (
                  <option value={storage.id}>
                    {storage.mount_path} · {storage.driver}
                  </option>
                )}
              </For>
            </select>
          </Box>
        </Flex>
        <Text my="$3">
          目标须为空且独占，源目标不能重叠或通过其他挂载别名写入。可用驱动组合由服务端预检决定，目标挂载在切换后停用。源文件会保留，清理须另行确认。
        </Text>
        <Box my="$3">
          <label>
            <input
              type="checkbox"
              checked={confirmed()}
              disabled={busy()}
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
            />{" "}
            {mode() === "incremental"
              ? "我确认采用增量原型，接受最终冻结源和目标存储及可能较长的全量核对。源端写入仅通过文件服务，外部程序及云端生命周期写入或删除已停止，旧直传授权已失效，目标可独占使用。"
              : "我确认接受全局停写，已停止外部程序和云端生命周期规则的写入或删除，旧直传授权已失效，目标可独占使用。"}
          </label>
        </Box>
        <Button
          colorScheme="primary"
          disabled={
            busy() ||
            !confirmed() ||
            !source() ||
            !target() ||
            source() === target()
          }
          onClick={() => void mutate("start")}
        >
          {busy() ? "正在处理…" : "确认并开始迁移"}
        </Button>
      </Box>
      <Box p="$4" borderWidth="1px" borderRadius="$lg">
        <Heading size="lg" mb="$3">
          迁移记录
        </Heading>
        <Show when={rows().length} fallback={<Text>暂无迁移记录</Text>}>
          <Flex gap="$2" flexWrap="wrap">
            <For each={rows()}>
              {(migration) => (
                <Button
                  variant={selected() === migration.id ? "solid" : "outline"}
                  onClick={() => void choose(migration.id)}
                >
                  {migration.source_mount_path} → {migration.target_mount_path}{" "}
                  · {migration.mode === "incremental" ? "增量原型" : "停写基线"}{" "}
                  · {phaseName(migration.phase)}
                </Button>
              )}
            </For>
          </Flex>
        </Show>
      </Box>
      <Show when={detail()}>
        {(current) => (
          <Box p="$4" borderWidth="1px" borderRadius="$lg">
            <Heading size="lg">{phaseName(current().migration.phase)}</Heading>
            <Text>
              迁移方式 ·{" "}
              {current().migration.mode === "incremental"
                ? "增量原型"
                : "停写基线"}
            </Text>
            <Show when={current().migration.mode === "incremental"}>
              <Text>
                最终补复制文件 · {current().migration.delta_copied_files ?? 0}
              </Text>
              <Text>
                最终停写实测 · {current().migration.final_freeze_millis ?? 0}{" "}
                毫秒（服务端已记录值）
              </Text>
              <Show
                when={
                  current().migration.final_freeze_started_at &&
                  !current().migration.final_freeze_started_at?.startsWith(
                    "0001",
                  )
                }
              >
                <Text style={{ "overflow-wrap": "anywhere" }}>
                  最终冻结开始 · {current().migration.final_freeze_started_at}
                </Text>
              </Show>
              <Text fontSize="$sm" color="$neutral11">
                最终核对会再次枚举和校验文件，耗时受数据量和云端吞吐影响。尚未开始时实测值为零。
              </Text>
            </Show>
            <Text css={{ overflowWrap: "anywhere" }}>
              迁移 ID · {current().migration.id}
            </Text>
            <Text>
              已校验文件 {verified().length} / {regularFiles().length} · 已复制{" "}
              {bytes(copiedBytes())}
            </Text>
            <Text fontSize="$sm" color="$neutral11">
              清单建立期间总数仍会变化。已复制字节按完成的文件累计。
            </Text>
            <progress
              aria-label="文件校验进度"
              max={Math.max(regularFiles().length, 1)}
              value={verified().length}
              style={{ width: "100%", height: "18px" }}
            />
            <Show
              when={
                current().migration.error_code ||
                current().migration.error_detail
              }
            >
              <Text
                role="alert"
                color="$danger11"
                css={{ overflowWrap: "anywhere" }}
              >
                {current().migration.error_code} ·{" "}
                {current().migration.error_detail}
              </Text>
            </Show>
            <Text my="$3">
              源数据保留中。历史链接有效期上界尚未确认，请保持源对象和云端访问权限可用，迁移完成不会自动删除源数据。
            </Text>
            <Flex gap="$2" mb="$3">
              <Button
                disabled={
                  busy() ||
                  current().migration.phase !== "failed" ||
                  current().migration.write_release_committed
                }
                onClick={() => void mutate("retry")}
              >
                重试失败任务
              </Button>
              <Button
                colorScheme="danger"
                disabled={busy() || !canCancel()}
                onClick={() => void mutate("cancel")}
              >
                取消迁移
              </Button>
            </Flex>
            <Heading size="base">文件错误 · {failures().length}</Heading>
            <For each={failures()} fallback={<Text>当前没有文件错误</Text>}>
              {(file) => (
                <Box py="$3" borderBottomWidth="1px">
                  <Text css={{ overflowWrap: "anywhere" }}>{file.path}</Text>
                  <Text fontSize="$sm">
                    {phaseName(file.phase)} · 尝试 {file.attempts} 次
                  </Text>
                  <Text color="$danger11" css={{ overflowWrap: "anywhere" }}>
                    {file.error_code} · {file.error_detail}
                  </Text>
                </Box>
              )}
            </For>
          </Box>
        )}
      </Show>
    </VStack>
  )
}

export default function MigrationPage() {
  return (
    <MustAdmin>
      <MigrationContent />
    </MustAdmin>
  )
}
