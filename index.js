// =============================================================
// index.js — 长期记忆插件（纯前端 SillyTavern 插件，单文件版）
//
// 架构：纯前端方案，无外部后端、无 mem0ai 依赖。
// 数据通过 getContext().extensionSettings 持久化到服务端 data/ 目录，
// 本地酒馆与云酒馆（Docker/Serv00 等）通用，多端同步、清缓存不丢失。
//
// 重要：本文件是「单文件自包含」版本。SillyTavern 的第三方插件
// 通过 <script> 方式加载 manifest.json 声明的 js 文件，不支持
// ES module 的相对 import，因此这里把 store / engine / llm /
// prompts / panel 全部内联，统一挂到全局 window.LTM 命名空间，
// 彻底避免「Extension failed to load」的模块解析错误。
//
// 安装：SillyTavern「扩展 → 插件」通过 GitHub 链接一键安装。
// =============================================================

(function (global) {
    'use strict';

    // 插件唯一 ID
    const PLUGIN_ID = 'long-term-memory';

    // ---------------------------------------------------------------------
    // 兼容层：获取 SillyTavern 上下文。不同版本/加载方式下，
    // getContext 可能来自 window.SillyTavern.getContext 或全局。
    // ---------------------------------------------------------------------
    function getSTContext() {
        try {
            if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
                return SillyTavern.getContext();
            }
            if (global.getContext && typeof global.getContext === 'function') {
                return global.getContext();
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    // =============================================================
    // 分区定义与默认设置
    // =============================================================
    const PARTITIONS = {
        emotional_tags: { label: '情绪标签', type: 'array' },
        key_events: { label: '关键事件', type: 'array' },
        special_occasions: { label: '纪念日', type: 'array' },
        character_diary: { label: '日记', type: 'array' },
        emotion_flow: { label: '情感流转', type: 'array' },
        todos: { label: '待办/约定', type: 'array' },
        important_items: { label: '重要物品', type: 'array' },
    };

    const DEFAULT_SETTINGS = {
        enabled: true,
        injectPrompt: true,
        summaryThreshold: 20,
        keepActiveFloors: 5,
        todoCheckInterval: 10,
        npcMinMentions: 3,
        debug: false,
    };

    // ---------------------------------------------------------------------
    // 默认 Prompt 定义（用户可通过面板覆盖）
    // ---------------------------------------------------------------------
    const DEFAULT_PROMPTS = {
        extract_facts: {
            name: '总库提炼',
            system: `你是「{{char}}」的长期记忆提取器。请从下面的对话片段中，提取出值得长期记住的关键信息，
并严格按 JSON 结构归类输出。只提取明确出现、值得保留的事实，不要臆测、不要编造。

【分区定义】
- emotional_tags: 「{{char}}」当前表现出的情绪标签（如"开心""烦躁""害羞"），用简短词概括。
- key_events: 对话中发生的关键事件、重要剧情节点、角色间的约定事实。
- special_occasions: 提到的特殊节日、纪念日、生日、重要日期（含日期信息）。
- character_diary: 「{{char}}」视角的日记式心路历程、内心独白。
- emotion_flow: 「{{char}}」情绪的变化流转（如"从警惕变为信任"）。
- todos: 「{{char}}」或用户明确做出的待办、约定、承诺（含是否已完成的判断）。
- important_items: 出现的重要物品/道具，格式为 {name, significance}（物品名 + 代表的意义/剧情）。
- npc: 对话中出现的其他角色（非 {{char}}），提取其名字和关键特征。

【严格规则】
1. 只输出一个合法的 JSON 对象，不要输出任何 JSON 以外的文字、解释、代码块标记或注释。
2. 如果某个分区没有可提取的内容，对应字段输出空数组 []（character_diary 输出空字符串 ""）。
3. 所有提取内容必须直接来源于对话原文，严禁虚构、推测或补充不存在的信息。
4. 情绪标签用 1-3 个简短中文词，不要输出长句。
5. important_items 的 significance 用一句话概括该物品在剧情中的意义。

【输出格式】严格输出如下 JSON（不要输出任何 JSON 以外的文字）：
{{json_schema}}

【待处理对话】
{{chunk}}`,
            user: '请执行提取。',
        },
        summarize_floors: {
            name: '楼层滚动总结',
            system: `你是「{{char}}」的记忆整理助手。下面是最近一段时间里滚出上下文的旧对话内容。
请把这些内容浓缩成一段简洁、信息密度高的结构化摘要，保留所有关键事实、情感变化、
约定和重要物品，删除寒暄和冗余。

【旧对话内容】
{{history}}

【要求】用中文输出，控制在 300 字以内，按时间顺序概括。`,
            user: '请总结。',
        },
        diary_entry: {
            name: '日记本总结',
            system: `你是「{{char}}」。请以第一人称视角，把下面这段对话写成一篇简短的角色日记，
记录你的所见、所感、所思。语气要贴合「{{char}}」的人设。

【对话内容】
{{chunk}}

【要求】80-150 字，第一人称，情感真挚。`,
            user: '请写日记。',
        },
        emotion_tag: {
            name: '情绪标签判定',
            system: `请判断「{{char}}」在下面这段话中表现出的情绪状态，用 1-3 个简短的情绪词概括
（例如：开心、焦虑、警惕、温柔、愤怒、害羞、期待）。只输出情绪词，用逗号分隔，不要输出其他内容。

【对话内容】
{{chunk}}`,
            user: '判断情绪。',
        },
        todo_extract: {
            name: '待办事项提取',
            system: `请从下面对话中提取「{{char}}」或用户明确做出的约定、承诺、待办事项。
每项输出为 JSON 对象：{ "content": "约定内容", "done": false }。
如果有多项，输出数组；如果没有任何约定，输出空数组 []。

【严格规则】
1. 只输出 JSON 数组，不要输出任何 JSON 以外的文字或解释。
2. 只提取明确说出口的约定/承诺/待办，不要凭空猜测。
3. content 要完整、具体，保留约定的关键信息（对象、时间、条件等）。

【对话内容】
{{chunk}}`,
            user: '提取待办。',
        },
        npc_recognize: {
            name: 'NPC 识别',
            system: `请识别下面对话中出现的、除了「{{char}}」之外的其他具名角色（NPC）。
只输出这些人名，用逗号分隔，不要输出其他内容。如果没有任何其他角色，输出空字符串。

【对话内容】
{{chunk}}`,
            user: '识别 NPC。',
        },
    };

    const EXTRACT_JSON_SCHEMA = `{
  "emotional_tags": ["情绪词1", "情绪词2"],
  "key_events": ["事件1", "事件2"],
  "special_occasions": ["纪念日1"],
  "character_diary": "日记片段",
  "emotion_flow": ["从X到Y的转变"],
  "todos": [{"content": "约定内容", "done": false}],
  "important_items": [{"name": "物品名", "significance": "意义"}],
  "npc": ["NPC名字1"]
}`;

    // =============================================================
    // 存储层（store）
    // =============================================================
    function extSettings() {
        return getSTContext()?.extensionSettings || {};
    }

    let __saveQueued = false;
    function saveSettings() {
        const ctx = getSTContext();
        if (__saveQueued) return;
        __saveQueued = true;
        if (typeof queueMicrotask === 'function') {
            queueMicrotask(() => { __saveQueued = false; });
        } else {
            setTimeout(() => { __saveQueued = false; }, 0);
        }
        if (typeof ctx?.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        } else if (typeof ctx?.saveExtensionSettings === 'function') {
            ctx.saveExtensionSettings();
        } else if (typeof ctx?.saveSettings === 'function') {
            ctx.saveSettings();
        }
    }

    function getAgentId() {
        const context = getSTContext();
        if (!context) return null;
        const char = context.characters?.[context.characterId];
        if (!char) return null;
        return `${char.name}::${context.characterId}`;
    }

    function getCharName() {
        const context = getSTContext();
        return context?.characters?.[context.characterId]?.name || '未知角色';
    }

    function getDatabase() {
        const s = extSettings();
        if (!s[PLUGIN_ID]) s[PLUGIN_ID] = {};
        if (!s[PLUGIN_ID].database) s[PLUGIN_ID].database = {};
        return s[PLUGIN_ID].database;
    }

    function createEmptyMemory() {
        return {
            emotional_tags: [],
            key_events: [],
            special_occasions: [],
            character_diary: [],
            emotion_flow: [],
            todos: [],
            important_items: [],
            npcs: {},
            meta: {
                created_at: Date.now(),
                updated_at: Date.now(),
                pendingFloors: 0,
                todoCounter: 0,
            },
        };
    }

    function getCharacterMemory(agentId) {
        const db = getDatabase();
        if (!db[agentId]) db[agentId] = createEmptyMemory();
        return db[agentId];
    }

    function getPartition(agentId, partition, npcName = null) {
        const mem = npcName
            ? getCharacterMemory(agentId).npcs[npcName]
            : getCharacterMemory(agentId);
        if (!mem) return [];
        return mem[partition] || [];
    }

    function addToPartition(agentId, partition, item, npcName = null) {
        const mem = npcName
            ? getCharacterMemory(agentId).npcs[npcName]
            : getCharacterMemory(agentId);
        if (!mem) return;
        if (!Array.isArray(mem[partition])) mem[partition] = [];
        if (Array.isArray(item)) {
            mem[partition].push(...item);
        } else {
            mem[partition].push(item);
        }
        getCharacterMemory(agentId).meta.updated_at = Date.now();
        saveSettings();
    }

    function updatePartitionItem(agentId, partition, index, newItem, npcName = null) {
        const mem = npcName
            ? getCharacterMemory(agentId).npcs[npcName]
            : getCharacterMemory(agentId);
        if (!mem || !Array.isArray(mem[partition]) || index < 0 || index >= mem[partition].length) {
            return false;
        }
        mem[partition][index] = newItem;
        getCharacterMemory(agentId).meta.updated_at = Date.now();
        saveSettings();
        return true;
    }

    function removePartitionItem(agentId, partition, index, npcName = null) {
        const mem = npcName
            ? getCharacterMemory(agentId).npcs[npcName]
            : getCharacterMemory(agentId);
        if (!mem || !Array.isArray(mem[partition]) || index < 0 || index >= mem[partition].length) {
            return false;
        }
        mem[partition].splice(index, 1);
        getCharacterMemory(agentId).meta.updated_at = Date.now();
        saveSettings();
        return true;
    }

    function clearMemory(agentId, partition = null) {
        const db = getDatabase();
        if (!db[agentId]) return;
        if (partition === null) {
            db[agentId] = createEmptyMemory();
        } else {
            const mem = db[agentId];
            if (Array.isArray(mem[partition])) mem[partition] = [];
        }
        saveSettings();
    }

    function markTodoDone(agentId, index, npcName = null) {
        const mem = npcName
            ? getCharacterMemory(agentId).npcs[npcName]
            : getCharacterMemory(agentId);
        if (!mem || !Array.isArray(mem.todos) || index < 0 || index >= mem.todos.length) {
            return false;
        }
        const todo = mem.todos[index];
        if (typeof todo === 'string') {
            mem.todos[index] = { content: todo, done: true };
        } else {
            todo.done = true;
        }
        getCharacterMemory(agentId).meta.updated_at = Date.now();
        saveSettings();
        return true;
    }

    function ensureNpcMemory(agentId, npcName) {
        const mem = getCharacterMemory(agentId);
        if (!mem.npcs[npcName]) {
            mem.npcs[npcName] = createEmptyMemory();
            mem.npcs[npcName].meta.is_npc = true;
            mem.npcs[npcName].meta.name = npcName;
            saveSettings();
        }
        return mem.npcs[npcName];
    }

    function listNpcs(agentId) {
        const mem = getCharacterMemory(agentId);
        return Object.keys(mem.npcs || {});
    }

    function removeNpc(agentId, npcName) {
        const mem = getCharacterMemory(agentId);
        if (mem.npcs && mem.npcs[npcName]) {
            delete mem.npcs[npcName];
            saveSettings();
            return true;
        }
        return false;
    }

    function getNpcMemory(agentId, npcName) {
        const mem = getCharacterMemory(agentId);
        return mem.npcs?.[npcName] || null;
    }

    function getSettings() {
        const s = extSettings();
        if (!s[PLUGIN_ID]) s[PLUGIN_ID] = {};
        if (!s[PLUGIN_ID].settings) {
            s[PLUGIN_ID].settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        }
        const cur = s[PLUGIN_ID].settings;
        for (const key in DEFAULT_SETTINGS) {
            if (cur[key] === undefined) cur[key] = DEFAULT_SETTINGS[key];
        }
        return cur;
    }

    function setSetting(key, value) {
        getSettings()[key] = value;
        saveSettings();
    }

    function getGroupCharNames() {
        const context = getSTContext();
        const names = [];
        const group = context?.groupId;
        const chars = context?.characters || {};
        if (group) {
            const members = context?.groups?.find?.(g => g.id === group)?.members || [];
            for (const m of members) {
                const name = chars[m]?.name;
                if (name) names.push(name);
            }
        } else if (context?.characterId != null) {
            names.push(getCharName());
        }
        return names;
    }

    // =============================================================
    // Prompt 层（prompts）
    // =============================================================
    function getPromptOverrides() {
        const s = extSettings();
        if (!s[PLUGIN_ID]) s[PLUGIN_ID] = {};
        return s[PLUGIN_ID].prompts || {};
    }

    function getPrompt(key) {
        const overrides = getPromptOverrides();
        const def = DEFAULT_PROMPTS[key];
        if (!def) return null;
        const custom = overrides[key];
        return {
            name: (custom && custom.name) || def.name,
            system: (custom && custom.system) || def.system,
            user: (custom && custom.user) || def.user,
        };
    }

    function getAllPrompts() {
        const result = {};
        for (const key in DEFAULT_PROMPTS) {
            result[key] = getPrompt(key);
        }
        return result;
    }

    function savePrompt(key, patch) {
        const s = extSettings();
        if (!s[PLUGIN_ID]) s[PLUGIN_ID] = {};
        if (!s[PLUGIN_ID].prompts) s[PLUGIN_ID].prompts = {};
        s[PLUGIN_ID].prompts[key] = {
            name: patch.name,
            system: patch.system,
            user: patch.user,
        };
        saveSettings();
    }

    function resetPrompt(key) {
        const s = extSettings();
        if (s[PLUGIN_ID] && s[PLUGIN_ID].prompts && s[PLUGIN_ID].prompts[key]) {
            delete s[PLUGIN_ID].prompts[key];
            saveSettings();
        }
    }

    // =============================================================
    // LLM 层（llm）
    // =============================================================
    function log(...args) {
        if (getSettings().debug) console.log('[LTM]', ...args);
    }

    async function generateQuiet(prompt, systemPrompt = null) {
        try {
            const context = getSTContext();
            if (!context || typeof context.generateQuietPrompt !== 'function') {
                console.warn('[LTM] 当前酒馆版本不支持 generateQuietPrompt');
                return '';
            }
            // 注意：generateQuietPrompt 只支持 quietPrompt 一个字段，
            // 不支持 systemPrompt 字段。必须把 system + user 合并进 quietPrompt，
            // 否则系统指令会被忽略，导致模型收到不完整指令、输出无意义内容。
            const merged = systemPrompt
                ? `${systemPrompt}\n\n---\n\n${prompt}`
                : prompt;
            const options = { quietPrompt: merged };
            const result = await context.generateQuietPrompt(options);
            return result ?? '';
        } catch (err) {
            console.warn('[LTM] generateQuiet 调用失败：', err);
            return '';
        }
    }

    async function generateWithRetry(prompt, systemPrompt = null, retries = 1) {
        for (let i = 0; i <= retries; i++) {
            const out = await generateQuiet(prompt, systemPrompt);
            if (out && out.trim()) return out;
        }
        return '';
    }

    function parseJsonFromText(text) {
        if (!text) return null;
        let cleaned = text.trim();
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start === -1 || end === -1 || end <= start) {
            const arrStart = cleaned.indexOf('[');
            const arrEnd = cleaned.lastIndexOf(']');
            if (arrStart !== -1 && arrEnd > arrStart) {
                cleaned = cleaned.slice(arrStart, arrEnd + 1);
            } else {
                return null;
            }
        } else {
            cleaned = cleaned.slice(start, end + 1);
        }
        try {
            return JSON.parse(cleaned);
        } catch (e) {
            console.warn('[LTM] JSON 解析失败');
            return null;
        }
    }

    // =============================================================
    // 记忆引擎（engine）
    // =============================================================
    function fillTemplate(tpl, vars) {
        let out = tpl;
        for (const k in vars) {
            out = out.split(`{{${k}}}`).join(String(vars[k] ?? ''));
        }
        return out;
    }

    async function extractFacts(agentId, chunkText) {
        const prompt = getPrompt('extract_facts');
        const charName = getCharName();

        const system = fillTemplate(prompt.system, {
            char: charName,
            chunk: chunkText,
            json_schema: EXTRACT_JSON_SCHEMA,
        });

        const out = await generateWithRetry(prompt.user, system);
        const data = parseJsonFromText(out);
        if (!data) {
            log('提取失败或输出非 JSON，跳过');
            return null;
        }

        if (Array.isArray(data.emotional_tags)) addToPartition(agentId, 'emotional_tags', data.emotional_tags);
        if (Array.isArray(data.key_events)) addToPartition(agentId, 'key_events', data.key_events);
        if (Array.isArray(data.special_occasions)) addToPartition(agentId, 'special_occasions', data.special_occasions);
        if (data.character_diary) addToPartition(agentId, 'character_diary', data.character_diary);
        if (Array.isArray(data.emotion_flow)) addToPartition(agentId, 'emotion_flow', data.emotion_flow);
        if (Array.isArray(data.todos)) addToPartition(agentId, 'todos', data.todos);
        if (Array.isArray(data.important_items)) addToPartition(agentId, 'important_items', data.important_items);
        if (Array.isArray(data.npc)) {
            for (const name of data.npc) {
                if (name && name.trim()) ensureNpcMemory(agentId, name.trim());
            }
        }

        log('提取完成，写入分区：', Object.keys(data));
        return data;
    }

    async function rollingSummarize(agentId, oldFloors) {
        const prompt = getPrompt('summarize_floors');
        const historyText = oldFloors
            .map((m) => `${m.is_user ? '用户' : getCharName()}：${m.content}`)
            .join('\n');

        const system = fillTemplate(prompt.system, {
            char: getCharName(),
            history: historyText,
        });

        const summary = await generateWithRetry(prompt.user, system);
        if (!summary || !summary.trim()) {
            log('楼层总结失败');
            return null;
        }

        addToPartition(agentId, 'key_events', `[楼层总结] ${summary.trim()}`);
        await extractFacts(agentId, summary.trim());
        log('楼层总结完成并写入');
        return summary;
    }

    async function manualSummarizeAll(agentId) {
        const context = getSTContext();
        const chat = context?.chat || [];
        const statusEl = document.getElementById('ltm-summarize-status');
        const setStatus = (msg, isErr = false) => {
            if (statusEl) {
                statusEl.style.display = 'block';
                statusEl.style.color = isErr ? '#b23a2a' : '#5e7a3e';
                statusEl.innerHTML = msg;
            }
        };

        if (!chat.length) {
            setStatus('<i class="fa-solid fa-circle-info"></i> 当前没有可总结的对话内容。', true);
            return;
        }

        setStatus('<i class="fa-solid fa-spinner fa-spin"></i> 正在用主模型总结，请稍候……');

        try {
            // 1) 整段对话滚动总结（提炼关键事件与剧情主线）
            const allText = chat
                .map((m) => `${m.is_user ? '用户' : getCharName()}：${m.mes}`)
                .join('\n');

            const summaryPrompt = getPrompt('summarize_floors');
            const summarySystem = fillTemplate(summaryPrompt.system, {
                char: getCharName(),
                history: allText,
            });
            const summary = await generateWithRetry(summaryPrompt.user, summarySystem);
            if (summary && summary.trim()) {
                addToPartition(agentId, 'key_events', `[一键总结] ${summary.trim()}`);
            }

            // 2) 结构化提取所有分区（情绪、事件、纪念日、日记、情感、待办、物品、NPC）
            await extractFacts(agentId, allText);

            // 3) 待办提取
            await checkTodosForce(agentId, allText);

            setStatus('<i class="fa-solid fa-circle-check"></i> 总结完成，记忆已更新。');
            renderCurrentView();
        } catch (err) {
            console.warn('[LTM] 一键总结失败：', err);
            setStatus('<i class="fa-solid fa-triangle-exclamation"></i> 总结失败，请检查酒馆主模型是否可用。', true);
        }
    }

    async function checkTodosForce(agentId, recentText) {
        const prompt = getPrompt('todo_extract');
        const system = fillTemplate(prompt.system, { char: getCharName(), chunk: recentText });
        const out = await generateWithRetry(prompt.user, system);
        const todos = parseJsonFromText(out);
        if (Array.isArray(todos) && todos.length) {
            addToPartition(agentId, 'todos', todos);
        }
    }

    async function checkTodos(agentId, recentText) {
        const settings = getSettings();
        const mem = getCharacterMemory(agentId);
        mem.meta.todoCounter = (mem.meta.todoCounter || 0) + 1;
        if (mem.meta.todoCounter < settings.todoCheckInterval) {
            return null;
        }
        mem.meta.todoCounter = 0;

        const prompt = getPrompt('todo_extract');
        const system = fillTemplate(prompt.system, { char: getCharName(), chunk: recentText });
        const out = await generateWithRetry(prompt.user, system);
        const todos = parseJsonFromText(out);
        if (Array.isArray(todos) && todos.length) {
            addToPartition(agentId, 'todos', todos);
        }

        const pending = mem.todos.filter((t) => !(t && t.done));
        return pending;
    }

    function buildInjectionPrompt(agentId) {
        const mem = getCharacterMemory(agentId);
        const parts = [];

        const push = (label, arr, formatter) => {
            if (arr && arr.length) {
                const body = formatter ? arr.map(formatter).join('；') : arr.join('；');
                parts.push(`${label}：${body}`);
            }
        };

        push('情绪标签', mem.emotional_tags);
        push('关键事件', mem.key_events);
        push('纪念日', mem.special_occasions);
        push('日记', mem.character_diary);
        push('情感流转', mem.emotion_flow);
        push('待办/约定', mem.todos.filter((t) => !(t && t.done)).map((t) => (typeof t === 'string' ? t : t.content)));
        push('重要物品', mem.important_items, (it) => (typeof it === 'string' ? it : `${it.name}（${it.significance}）`));

        for (const npcName in mem.npcs) {
            const npcMem = mem.npcs[npcName];
            const npcKeyEvents = npcMem.key_events || [];
            if (npcKeyEvents.length) {
                parts.push(`【${npcName}】的关键事件：${npcKeyEvents.join('；')}`);
            }
        }

        if (!parts.length) return '';
        return `\n\n[以下是你（${getCharName()}）的长期记忆，请自然融入你的回答，不要直接复述这些文字]\n${parts.join('\n')}`;
    }

    async function processUserMessage(userText) {
        const settings = getSettings();
        if (!settings.enabled) return '';

        const agentId = getAgentId();
        if (!agentId) return '';

        const context = getSTContext();
        const chat = context?.chat || [];
        const totalFloors = chat.length;
        const threshold = settings.summaryThreshold;
        const keep = settings.keepActiveFloors;

        const mem = getCharacterMemory(agentId);

        const overflow = Math.max(0, totalFloors - keep);
        mem.meta.pendingFloors = (mem.meta.pendingFloors || 0) + overflow;

        if (mem.meta.pendingFloors >= threshold) {
            const oldFloors = chat.slice(0, Math.max(0, totalFloors - keep)).map((m) => ({
                is_user: m.is_user,
                content: String(m.mes),
            }));
            if (oldFloors.length) {
                await rollingSummarize(agentId, oldFloors);
            }
            mem.meta.pendingFloors = 0;
        }

        const recent = chat.slice(-6).map((m) => `${m.is_user ? '用户' : getCharName()}：${m.mes}`).join('\n');
        await extractFacts(agentId, recent);
        await checkTodos(agentId, recent);

        return buildInjectionPrompt(agentId);
    }

    // =============================================================
    // 管理面板（panel）
    // =============================================================
    function esc(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    const PART_ICONS = {
        emotional_tags: 'fa-face-smile',
        key_events: 'fa-bolt',
        special_occasions: 'fa-cake-candles',
        character_diary: 'fa-book-open',
        emotion_flow: 'fa-heart-pulse',
        todos: 'fa-list-check',
        important_items: 'fa-box-archive',
    };

    const PART_TABS = [
        { key: 'key_events', label: '关键事件' },
        { key: 'special_occasions', label: '特殊节日' },
        { key: 'emotional_tags', label: '情绪标签' },
        { key: 'character_diary', label: '日记本' },
        { key: 'emotion_flow', label: '情感流转' },
    ];

    let currentNpc = null;
    let currentPart = 'key_events';
    let currentView = 'memory';

    function ensureFontAwesome() {
        if (document.getElementById('ltm-fa-css')) return;
        const existing = [...document.styleSheets].some((s) => {
            try { return (s.href || '').includes('font-awesome') || (s.href || '').includes('fontawesome'); } catch (e) { return false; }
        });
        if (existing) return;
        const link = document.createElement('link');
        link.id = 'ltm-fa-css';
        link.rel = 'stylesheet';
        link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css';
        link.crossOrigin = 'anonymous';
        link.referrerPolicy = 'no-referrer';
        document.head.appendChild(link);
    }

    // 关键：动态注入面板样式，确保不依赖 manifest 的 css 字段是否被加载。
    // 这样即使酒馆版本/主题没有加载 style.css，面板样式也能 100% 生效。
    function ensurePanelStyles() {
        if (document.getElementById('ltm-panel-style')) return;
        const style = document.createElement('style');
        style.id = 'ltm-panel-style';
        style.textContent = `
#ltm-fab{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:30000;width:52px;height:52px;cursor:grab;user-select:none;-webkit-user-select:none;transition:transform .2s ease,right .25s ease;touch-action:none;}
#ltm-fab .ltm-fab-ball{width:100%;height:100%;border-radius:14px;background:linear-gradient(135deg,#8c1c1c,#5e1010);border:1px solid rgba(201,168,106,.6);box-shadow:0 2px 12px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;color:#f6f1e6;font-size:22px;transition:all .25s ease;position:relative;}
#ltm-fab .ltm-fab-label{position:absolute;right:56px;top:50%;transform:translateY(-50%);white-space:nowrap;background:rgba(94,16,16,.9);color:#f6f1e6;font-size:12px;padding:4px 10px;border-radius:8px;opacity:0;pointer-events:none;transition:opacity .2s ease;}
#ltm-fab:hover .ltm-fab-label{opacity:1;}
#ltm-fab.ltm-fab-collapsed{right:-39px;}
#ltm-fab.ltm-fab-collapsed:hover,#ltm-fab.ltm-fab-collapsed.ltm-fab-dragging{right:0;}
#ltm-panel-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.35);z-index:29999;opacity:0;pointer-events:none;transition:opacity .25s ease;}
#ltm-panel-overlay.ltm-open{opacity:1;pointer-events:auto;}
#ltm-panel-drawer{position:fixed;top:0;right:0;bottom:0;width:460px;max-width:92vw;height:100vh;z-index:30001;background-color:#f6f1e6;background-image:linear-gradient(160deg,#f6f1e6,#efe6d3);border-left:1px solid rgba(140,28,28,.25);box-shadow:-6px 0 24px rgba(0,0,0,.25);transform:translateX(105%);transition:transform .3s cubic-bezier(.22,1,.36,1);display:flex;flex-direction:column;color:#3a2f2a;box-sizing:border-box;overflow:hidden;font-family:'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif;}
#ltm-panel-drawer.ltm-open{transform:translateX(0);}
.ltm-drawer-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;background:linear-gradient(120deg,rgba(94,16,16,.9),rgba(140,28,28,.85));border-bottom:1px solid rgba(255,255,255,.15);color:#f6f1e6;flex-shrink:0;}
.ltm-drawer-logo{font-weight:700;font-size:1.15rem;letter-spacing:.06em;display:flex;align-items:center;gap:8px;}
.ltm-drawer-logo i{color:#c9a86a;}
.ltm-drawer-close{background:none;border:1px solid rgba(255,255,255,.3);border-radius:50%;width:30px;height:30px;color:#f6f1e6;cursor:pointer;display:flex;align-items:center;justify-content:center;}
.ltm-nav-tabs{display:flex;flex-wrap:wrap;gap:6px;padding:10px 16px;border-bottom:1px solid rgba(140,28,28,.2);flex-shrink:0;background:rgba(255,255,255,.25);}
.ltm-nav-tab{font-size:.8rem;font-weight:600;color:rgba(58,47,42,.7);background:transparent;border:1px solid transparent;padding:6px 13px;border-radius:999px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px;}
.ltm-nav-tab.ltm-active{background:rgba(140,28,28,.9);color:#f6f1e6;border-color:#c9a86a;}
.ltm-drawer-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:16px;-webkit-overflow-scrolling:touch;}
.ltm-card{background:rgba(255,255,255,.55);border:1px solid rgba(140,28,28,.25);border-top:3px solid #8c1c1c;border-radius:12px;padding:14px;margin-bottom:14px;box-sizing:border-box;}
.ltm-card-title{font-weight:700;font-size:1rem;display:flex;align-items:center;justify-content:space-between;gap:8px;padding-bottom:10px;margin-bottom:12px;border-bottom:1px dashed rgba(140,28,28,.25);color:#5e1010;}
.ltm-card-title i{color:#c9a86a;}
.ltm-title-left{display:inline-flex;align-items:center;gap:8px;}
.ltm-field-label{display:block;font-size:.8rem;font-weight:600;margin:12px 0 6px;color:#5e1010;}
.ltm-input,.ltm-textarea{width:100%;box-sizing:border-box;font-size:.85rem;color:#3a2f2a;background:rgba(255,255,255,.65);border:1px solid rgba(140,28,28,.25);border-radius:8px;padding:9px 12px;resize:vertical;outline:none;}
.ltm-btn{font-weight:600;background:#8c1c1c;color:#f6f1e6;border:1px solid #5e1010;border-radius:8px;padding:7px 16px;cursor:pointer;font-size:.82rem;white-space:nowrap;}
.ltm-btn-ghost{background:transparent;color:#5e1010;border:1px solid rgba(140,28,28,.35);}
.ltm-btn-danger{background:transparent;color:#b23a2a;border:1px solid rgba(178,58,42,.4);}
.ltm-btn-sm{padding:3px 10px;font-size:.75rem;border-radius:6px;}
.ltm-btn-add{margin-top:10px;background:transparent;border:1px dashed #8c1c1c;color:#5e1010;border-radius:8px;padding:7px 16px;font-size:.8rem;cursor:pointer;width:100%;}
.ltm-item{display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px dashed rgba(140,28,28,.18);}
.ltm-item-text{flex:1;word-break:break-word;font-size:.85rem;line-height:1.5;min-width:0;}
.ltm-item-text[contenteditable="true"]{outline:none;cursor:text;}
.ltm-item-actions{display:flex;gap:4px;flex-shrink:0;}
.ltm-empty{color:#a0938a;font-size:.85em;font-style:italic;padding:6px 0;}
.ltm-done .ltm-item-text{text-decoration:line-through;color:#a0938a;}
.ltm-tag-list{display:flex;flex-wrap:wrap;gap:8px;}
.ltm-tag{font-size:.8rem;background:rgba(201,168,106,.2);border:1px solid rgba(201,168,106,.5);color:#7a5c3e;border-radius:999px;padding:4px 12px;display:inline-flex;align-items:center;gap:6px;}
.ltm-tag .ltm-tag-del{cursor:pointer;color:#b23a2a;font-weight:700;}
.ltm-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;}
.ltm-char-card,.ltm-item-card{background:rgba(255,255,255,.55);border:1px solid rgba(140,28,28,.25);border-radius:12px;padding:12px;text-align:center;cursor:pointer;position:relative;}
.ltm-char-icon,.ltm-item-icon{font-size:1.5rem;color:#8c1c1c;margin-bottom:6px;}
.ltm-char-name{font-size:.82rem;font-weight:600;color:#3a2f2a;}
.ltm-item-name{font-size:.82rem;font-weight:700;color:#5e1010;outline:none;margin-bottom:4px;}
.ltm-item-desc{font-size:.72rem;color:#7a6a5f;outline:none;line-height:1.4;}
.ltm-card-delete{position:absolute;top:6px;right:6px;background:none;border:none;color:#b23a2a;cursor:pointer;font-size:.85rem;}
.ltm-add-card{display:flex;align-items:center;justify-content:center;border-style:dashed;color:#8c1c1c;font-size:1.4rem;cursor:pointer;min-height:70px;}
.ltm-prompt-item{margin-bottom:16px;border-bottom:1px dashed rgba(140,28,28,.2);padding-bottom:14px;}
.ltm-prompt-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}
.ltm-prompt-name{font-weight:700;font-size:.9rem;color:#5e1010;}
.ltm-hint{font-size:.78rem;color:#7a5c3e;background:rgba(201,168,106,.16);border:1px solid rgba(201,168,106,.35);border-radius:8px;padding:8px 10px;margin:12px 0;line-height:1.5;}
.ltm-switch-row{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px dashed rgba(140,28,28,.15);font-size:.88rem;}
.ltm-switch{position:relative;width:44px;height:24px;flex-shrink:0;}
.ltm-switch input{opacity:0;width:0;height:0;}
.ltm-switch .ltm-slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.2);border-radius:999px;transition:.25s;}
.ltm-switch .ltm-slider::before{content:"";position:absolute;height:18px;width:18px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.25s;}
.ltm-switch input:checked+.ltm-slider{background:#8c1c1c;}
.ltm-switch input:checked+.ltm-slider::before{transform:translateX(20px);}
.ltm-pill-group{display:flex;gap:8px;margin:8px 0;flex-wrap:wrap;}
.ltm-pill{flex:1;min-width:60px;font-weight:600;font-size:.85rem;background:rgba(255,255,255,.5);border:1px solid rgba(140,28,28,.25);color:#3a2f2a;border-radius:999px;padding:7px 0;cursor:pointer;text-align:center;}
.ltm-pill.ltm-active{background:#8c1c1c;color:#f6f1e6;border-color:#5e1010;}
@media(max-width:640px){#ltm-panel-drawer{width:100vw;max-width:100vw;}.ltm-grid{grid-template-columns:1fr 1fr;}.ltm-nav-tabs{overflow-x:auto;flex-wrap:nowrap;}}
        `;
        document.head.appendChild(style);
    }

    function mountPanelShell() {
        ensureFontAwesome();
        ensurePanelStyles();
        if (document.getElementById('ltm-panel-drawer')) return;

        const shell = document.createElement('div');
        shell.style.cssText = 'all:initial;';
        shell.innerHTML = `
        <div id="ltm-fab" class="ltm-fab-collapsed" title="记忆档案">
            <div class="ltm-fab-ball"><i class="fa-solid fa-scroll"></i></div>
            <div class="ltm-fab-label">记忆档案</div>
        </div>
        <div id="ltm-panel-overlay"></div>
        <aside id="ltm-panel-drawer" style="background-color:#f6f1e6;background-image:linear-gradient(160deg,#f6f1e6,#efe6d3);">
            <div class="ltm-drawer-head">
                <div class="ltm-drawer-logo"><i class="fa-solid fa-scroll"></i> 记忆档案 · ARCHIVE</div>
                <button class="ltm-drawer-close" id="ltm-panel-close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="ltm-nav-tabs" id="ltm-nav-tabs">
                <button class="ltm-nav-tab ltm-active" data-view="memory"><i class="fa-solid fa-landmark"></i> 记忆殿堂</button>
                <button class="ltm-nav-tab" data-view="npc"><i class="fa-solid fa-user-group"></i> NPC</button>
                <button class="ltm-nav-tab" data-view="other"><i class="fa-solid fa-inbox"></i> 其他</button>
                <button class="ltm-nav-tab" data-view="prompts"><i class="fa-solid fa-terminal"></i> 提示词</button>
                <button class="ltm-nav-tab" data-view="settings"><i class="fa-solid fa-gear"></i> 设置</button>
            </div>
            <div class="ltm-drawer-body" id="ltm-drawer-body" style="flex:1 1 auto;min-height:0;overflow-y:auto;padding:16px;"></div>
        </aside>
        `;
        document.body.appendChild(shell);

        bindFabDrag();
        bindShellEvents();
    }

    function bindShellEvents() {
        const fab = document.getElementById('ltm-fab');
        const overlay = document.getElementById('ltm-panel-overlay');

        fab.addEventListener('click', openPanel);
        document.getElementById('ltm-panel-close').addEventListener('click', closePanel);
        overlay.addEventListener('click', closePanel);

        document.getElementById('ltm-nav-tabs').addEventListener('click', (e) => {
            const tab = e.target.closest('.ltm-nav-tab');
            if (!tab) return;
            switchView(tab.dataset.view);
        });
    }

    function openPanel() {
        document.getElementById('ltm-panel-drawer').classList.add('ltm-open');
        document.getElementById('ltm-panel-overlay').classList.add('ltm-open');
        renderCurrentView();
    }

    function closePanel() {
        document.getElementById('ltm-panel-drawer').classList.remove('ltm-open');
        document.getElementById('ltm-panel-overlay').classList.remove('ltm-open');
    }

    function bindFabDrag() {
        const fab = document.getElementById('ltm-fab');
        let dragging = false;
        let moved = false;
        let startX = 0, startY = 0, origX = 0, origY = 0;

        const onStart = (clientX, clientY) => {
            dragging = true;
            moved = false;
            startX = clientX;
            startY = clientY;
            const rect = fab.getBoundingClientRect();
            origX = rect.left;
            origY = rect.top;
            fab.classList.add('ltm-fab-dragging');
            fab.classList.remove('ltm-fab-collapsed');
            fab.style.transition = 'none';
        };

        const onMove = (clientX, clientY) => {
            if (!dragging) return;
            const dx = clientX - startX;
            const dy = clientY - startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;

            let left = origX + dx;
            let top = origY + dy;
            left = Math.max(0, Math.min(window.innerWidth - 52, left));
            top = Math.max(0, Math.min(window.innerHeight - 52, top));

            fab.style.left = left + 'px';
            fab.style.top = top + 'px';
            fab.style.right = 'auto';
            fab.style.transform = 'none';
        };

        const onEnd = () => {
            if (!dragging) return;
            dragging = false;
            fab.classList.remove('ltm-fab-dragging');
            fab.style.transition = '';
            if (!moved) return;
            const rect = fab.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            if (centerX < window.innerWidth / 2) {
                fab.style.left = '0';
                fab.style.right = 'auto';
            } else {
                fab.style.left = 'auto';
                fab.style.right = '0';
            }
        };

        fab.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            onStart(e.clientX, e.clientY);
        });
        document.addEventListener('mousemove', (e) => {
            if (dragging) onMove(e.clientX, e.clientY);
        });
        document.addEventListener('mouseup', onEnd);

        fab.addEventListener('touchstart', (e) => {
            const t = e.touches[0];
            onStart(t.clientX, t.clientY);
        }, { passive: true });
        document.addEventListener('touchmove', (e) => {
            if (dragging) onMove(e.touches[0].clientX, e.touches[0].clientY);
        }, { passive: true });
        document.addEventListener('touchend', onEnd);

        fab.addEventListener('click', (e) => {
            if (moved) {
                e.stopPropagation();
                e.preventDefault();
                moved = false;
            }
        }, true);
    }

    function switchView(view) {
        currentView = view;
        document.querySelectorAll('#ltm-nav-tabs .ltm-nav-tab').forEach((t) => {
            t.classList.toggle('ltm-active', t.dataset.view === view);
        });
        renderCurrentView();
    }

    function renderCurrentView() {
        const body = document.getElementById('ltm-drawer-body');
        if (!body) return;
        switch (currentView) {
            case 'memory': body.innerHTML = renderMemoryView(); break;
            case 'npc': body.innerHTML = renderNpcView(); break;
            case 'other': body.innerHTML = renderOtherView(); break;
            case 'prompts': body.innerHTML = renderPromptsView(); break;
            case 'settings': body.innerHTML = renderSettingsView(); break;
            default: body.innerHTML = '';
        }
        bindViewEvents();
    }

    function renderMemoryView() {
        const agentId = getAgentId();
        if (!agentId) {
            return '<div class="ltm-empty">尚未选择角色卡，请先在酒馆中打开一个角色。</div>';
        }

        const groupNames = getGroupCharNames();
        const chars = groupNames.length > 1 ? groupNames : [getCharName()];

        const charCards = chars.map((name) => {
            return `<div class="ltm-char-card" data-char="${esc(name)}">
                <div class="ltm-char-icon"><i class="fa-solid fa-user-ninja"></i></div>
                <div class="ltm-char-name">${esc(name)}</div>
            </div>`;
        }).join('');

        return `
        <div class="ltm-view ltm-active">
            <div class="ltm-card">
                <div class="ltm-card-title">
                    <span class="ltm-title-left"><i class="fa-solid fa-users"></i> 选择角色</span>
                </div>
                <div class="ltm-grid">${charCards}</div>
                <p class="ltm-hint"><i class="fa-solid fa-circle-info"></i> 点击角色查看并编辑其记忆。多人卡中每个角色独立建档，互不干扰。</p>
            </div>
            <div id="ltm-memory-detail"></div>
        </div>`;
    }

    function renderMemoryDetail(agentId, charName) {
        currentNpc = null;
        currentPart = 'key_events';
        return `
        <div class="ltm-card">
            <div class="ltm-card-title">
                <span class="ltm-title-left"><i class="fa-solid fa-book-open-reader"></i> 「${esc(charName)}」记忆库</span>
                <button class="ltm-btn ltm-btn-danger ltm-btn-sm" data-act="clear-all">清空全部</button>
            </div>
            ${renderPartitionTabs()}
            <div id="ltm-part-content"></div>
        </div>`;
    }

    function renderPartitionTabs() {
        const tabs = PART_TABS.map((t) => `
            <button class="ltm-pill ${t.key === currentPart ? 'ltm-active' : ''}" data-part="${t.key}">
                <i class="fa-solid ${PART_ICONS[t.key] || 'fa-cube'}"></i> ${t.label}
            </button>`).join('');
        return `<div class="ltm-pill-group">${tabs}</div>`;
    }

    function renderPartitionContent(agentId, npcName) {
        const mem = npcName ? getNpcMemory(agentId, npcName) : getCharacterMemory(agentId);
        const arr = mem?.[currentPart] || [];
        const isTag = currentPart === 'emotional_tags';

        let body = '';
        if (isTag) {
            body = renderTags(arr, agentId, npcName);
        } else {
            body = arr.length
                ? arr.map((it, i) => renderEditableItem(currentPart, it, i, agentId, npcName)).join('')
                : '<div class="ltm-empty">（暂无内容）</div>';
        }

        const addLabel = isTag ? '添加标签' : (currentPart === 'important_items' ? '添加物品' : '添加条目');

        return `
        ${body}
        <button class="ltm-btn-add" data-act="add" data-part="${currentPart}" data-npc="${esc(npcName || '')}">
            <i class="fa-solid fa-plus"></i> ${addLabel}
        </button>`;
    }

    function renderTags(arr, agentId, npcName) {
        if (!arr.length) return '<div class="ltm-empty">（暂无标签）</div>';
        return `<div class="ltm-tag-list">
            ${arr.map((tag, i) => `
                <span class="ltm-tag">
                    <span contenteditable="true" data-editable data-part="emotional_tags" data-idx="${i}" data-npc="${esc(npcName || '')}">${esc(tag)}</span>
                    <span class="ltm-tag-del" data-act="del" data-part="emotional_tags" data-idx="${i}" data-npc="${esc(npcName || '')}">×</span>
                </span>`).join('')}
        </div>`;
    }

    function renderEditableItem(part, item, index, agentId, npcName) {
        const npcAttr = esc(npcName || '');

        if (part === 'todos') {
            const content = typeof item === 'string' ? item : item.content;
            const done = typeof item === 'object' && item.done;
            return `
            <div class="ltm-item ${done ? 'ltm-done' : ''}">
                <span class="ltm-item-text" contenteditable="true" data-editable data-part="todos" data-idx="${index}" data-npc="${npcAttr}">${esc(content)}</span>
                <div class="ltm-item-actions">
                    ${!done ? `<button class="ltm-btn ltm-btn-sm" data-act="todo-done" data-idx="${index}" data-npc="${npcAttr}">完成</button>` : ''}
                    <button class="ltm-btn ltm-btn-sm ltm-btn-danger" data-act="del" data-part="todos" data-idx="${index}" data-npc="${npcAttr}">删</button>
                </div>
            </div>`;
        }

        if (part === 'important_items') {
            const name = typeof item === 'string' ? item : item.name;
            const sig = typeof item === 'object' ? item.significance : '';
            return `
            <div class="ltm-item">
                <div class="ltm-item-text" style="flex-direction:column;display:flex;gap:2px;">
                    <b contenteditable="true" data-editable data-part="important_items" data-idx="${index}" data-field="name" data-npc="${npcAttr}">${esc(name)}</b>
                    <span style="color:#7a6a5f;font-size:0.78em;" contenteditable="true" data-editable data-part="important_items" data-idx="${index}" data-field="significance" data-npc="${npcAttr}">${esc(sig || '（点击填写意义）')}</span>
                </div>
                <div class="ltm-item-actions">
                    <button class="ltm-btn ltm-btn-sm ltm-btn-danger" data-act="del" data-part="important_items" data-idx="${index}" data-npc="${npcAttr}">删</button>
                </div>
            </div>`;
        }

        return `
        <div class="ltm-item">
            <span class="ltm-item-text" contenteditable="true" data-editable data-part="${part}" data-idx="${index}" data-npc="${npcAttr}">${esc(item)}</span>
            <div class="ltm-item-actions">
                <button class="ltm-btn ltm-btn-sm ltm-btn-danger" data-act="del" data-part="${part}" data-idx="${index}" data-npc="${npcAttr}">删</button>
            </div>
        </div>`;
    }

    function renderNpcView() {
        const agentId = getAgentId();
        if (!agentId) return '<div class="ltm-empty">尚未选择角色卡。</div>';

        const npcs = listNpcs(agentId);
        const cards = npcs.length
            ? npcs.map((n) => `
                <div class="ltm-char-card" data-npc="${esc(n)}">
                    <div class="ltm-char-icon"><i class="fa-solid fa-user-secret"></i></div>
                    <div class="ltm-char-name">${esc(n)}</div>
                    <button class="ltm-card-delete" data-act="del-npc" data-npc="${esc(n)}" title="删除建档"><i class="fa-solid fa-trash"></i></button>
                </div>`).join('')
            : '<div class="ltm-empty">（暂无 NPC 建档）</div>';

        return `
        <div class="ltm-view ltm-active">
            <div class="ltm-card">
                <div class="ltm-card-title">
                    <span class="ltm-title-left"><i class="fa-solid fa-user-group"></i> NPC 动态建档库</span>
                    <button class="ltm-btn ltm-btn-sm" data-act="add-npc">+ 手动建档</button>
                </div>
                <div class="ltm-grid">${cards}</div>
                <p class="ltm-hint"><i class="fa-solid fa-circle-info"></i> 对话中频繁出现的 NPC 会自动建档；也可手动创建。</p>
            </div>
            <div id="ltm-npc-detail"></div>
        </div>`;
    }

    function renderOtherView() {
        const agentId = getAgentId();
        if (!agentId) return '<div class="ltm-empty">尚未选择角色卡。</div>';
        const mem = getCharacterMemory(agentId);

        const todos = mem.todos || [];
        const todoHtml = todos.length
            ? todos.map((t, i) => {
                const content = typeof t === 'string' ? t : t.content;
                const done = typeof t === 'object' && t.done;
                return `<div class="ltm-item ${done ? 'ltm-done' : ''}">
                    <span class="ltm-item-text" contenteditable="true" data-editable data-part="todos" data-idx="${i}">${esc(content)}</span>
                    <div class="ltm-item-actions">
                        ${!done ? `<button class="ltm-btn ltm-btn-sm" data-act="todo-done" data-idx="${i}">完成</button>` : ''}
                        <button class="ltm-btn ltm-btn-sm ltm-btn-danger" data-act="del" data-part="todos" data-idx="${i}">删</button>
                    </div>
                </div>`;
            }).join('')
            : '<div class="ltm-empty">（暂无待办）</div>';

        const items = mem.important_items || [];
        const itemHtml = items.length
            ? `<div class="ltm-grid">
                ${items.map((it, i) => {
                    const name = typeof it === 'string' ? it : it.name;
                    const sig = typeof it === 'object' ? it.significance : '';
                    return `<div class="ltm-item-card">
                        <button class="ltm-card-delete" data-act="del" data-part="important_items" data-idx="${i}" title="删除"><i class="fa-solid fa-trash"></i></button>
                        <div class="ltm-item-icon"><i class="fa-solid fa-gem"></i></div>
                        <div class="ltm-item-name" contenteditable="true" data-editable data-part="important_items" data-idx="${i}" data-field="name">${esc(name)}</div>
                        <div class="ltm-item-desc" contenteditable="true" data-editable data-part="important_items" data-idx="${i}" data-field="significance">${esc(sig || '（点击填写意义）')}</div>
                    </div>`;
                }).join('')}
                <div class="ltm-item-card ltm-add-card" data-act="add" data-part="important_items"><i class="fa-solid fa-plus"></i></div>
            </div>`
            : `<div class="ltm-empty">（暂无物品）</div><div class="ltm-grid"><div class="ltm-item-card ltm-add-card" data-act="add" data-part="important_items"><i class="fa-solid fa-plus"></i></div></div>`;

        return `
        <div class="ltm-view ltm-active">
            <div class="ltm-card">
                <div class="ltm-card-title">
                    <span class="ltm-title-left"><i class="fa-solid fa-list-check"></i> 待办事项 / 约定</span>
                </div>
                ${todoHtml}
                <button class="ltm-btn-add" data-act="add" data-part="todos"><i class="fa-solid fa-plus"></i> 新增事项</button>
            </div>
            <div class="ltm-card">
                <div class="ltm-card-title">
                    <span class="ltm-title-left"><i class="fa-solid fa-box-archive"></i> 重要物品库</span>
                </div>
                ${itemHtml}
            </div>
        </div>`;
    }

    function renderPromptsView() {
        const prompts = getAllPrompts();
        const items = Object.keys(prompts).map((key) => {
            const p = prompts[key];
            return `
            <div class="ltm-prompt-item" data-prompt-key="${esc(key)}">
                <div class="ltm-prompt-head">
                    <span class="ltm-prompt-name"><i class="fa-solid fa-terminal"></i> ${esc(p.name)}</span>
                    <button class="ltm-btn ltm-btn-sm ltm-btn-ghost" data-act="reset-prompt" data-key="${esc(key)}">恢复默认</button>
                </div>
                <label class="ltm-field-label">系统提示词（System）</label>
                <textarea class="ltm-textarea ltm-prompt-system" rows="6" data-key="${esc(key)}">${esc(p.system)}</textarea>
                <label class="ltm-field-label">用户指令（User）</label>
                <textarea class="ltm-textarea ltm-prompt-user" rows="2" data-key="${esc(key)}">${esc(p.user)}</textarea>
            </div>`;
        }).join('');

        return `
        <div class="ltm-view ltm-active">
            <div class="ltm-card">
                <div class="ltm-card-title">
                    <span class="ltm-title-left"><i class="fa-solid fa-terminal"></i> 提示词配置</span>
                    <button class="ltm-btn ltm-btn-sm" data-act="save-all-prompts">保存全部</button>
                </div>
                ${items}
                <p class="ltm-hint"><i class="fa-solid fa-circle-info"></i> 修改后点击「保存全部」写回服务端，对所有设备生效。支持 {{char}} {{chunk}} {{history}} {{json_schema}} 等占位符。</p>
            </div>
        </div>`;
    }

    function renderSettingsView() {
        const s = getSettings();
        const thresholdPills = [10, 20, 50].map((v) =>
            `<button class="ltm-pill ${s.summaryThreshold === v ? 'ltm-active' : ''}" data-setting="summaryThreshold" data-value="${v}">${v} 层</button>`
        ).join('');

        return `
        <div class="ltm-view ltm-active">
            <div class="ltm-card">
                <div class="ltm-card-title"><span class="ltm-title-left"><i class="fa-solid fa-gear"></i> 插件设置</span></div>

                <div class="ltm-switch-row">
                    <span>启用长期记忆（总开关）</span>
                    <label class="ltm-switch"><input type="checkbox" data-setting="enabled" ${s.enabled ? 'checked' : ''}><span class="ltm-slider"></span></label>
                </div>
                <div class="ltm-switch-row">
                    <span>注入记忆到提示词</span>
                    <label class="ltm-switch"><input type="checkbox" data-setting="injectPrompt" ${s.injectPrompt ? 'checked' : ''}><span class="ltm-slider"></span></label>
                </div>
                <div class="ltm-switch-row">
                    <span>调试日志</span>
                    <label class="ltm-switch"><input type="checkbox" data-setting="debug" ${s.debug ? 'checked' : ''}><span class="ltm-slider"></span></label>
                </div>

                <label class="ltm-field-label">总结触发阈值（楼层数）</label>
                <div class="ltm-pill-group">${thresholdPills}</div>
                <input type="number" class="ltm-input" data-setting="summaryThreshold" value="${s.summaryThreshold}" min="5">

                <label class="ltm-field-label">保留最近活跃楼层数</label>
                <input type="number" class="ltm-input" data-setting="keepActiveFloors" value="${s.keepActiveFloors}" min="1">

                <label class="ltm-field-label">待办检查频率（每 N 轮）</label>
                <input type="number" class="ltm-input" data-setting="todoCheckInterval" value="${s.todoCheckInterval}" min="1">
            </div>

            <div class="ltm-card">
                <div class="ltm-card-title"><span class="ltm-title-left"><i class="fa-solid fa-wand-magic-sparkles"></i> 一键总结</span></div>
                <p class="ltm-hint"><i class="fa-solid fa-circle-info"></i> 立即用酒馆主模型总结当前角色的全部对话，提炼关键事件、情绪、待办、物品等，并写入记忆库。</p>
                <button class="ltm-btn" data-act="summarize-now" style="width:100%;padding:12px;">
                    <i class="fa-solid fa-bolt"></i> 立即总结当前对话
                </button>
                <p class="ltm-hint" id="ltm-summarize-status" style="display:none;margin-top:10px;"></p>
            </div>

            <div class="ltm-card">
                <div class="ltm-card-title"><span class="ltm-title-left"><i class="fa-solid fa-plug"></i> 模型说明</span></div>
                <p class="ltm-hint" style="margin:0;"><i class="fa-solid fa-circle-check"></i> 本插件无需外接 API。记忆提取与总结自动使用「酒馆当前选中的主模型」，无需额外填写 Key 或接口地址。</p>
            </div>

            <div class="ltm-card">
                <p class="ltm-hint" style="margin:0;"><i class="fa-solid fa-shield-halved"></i> 所有记忆数据自动落盘到酒馆服务端（data/ 目录），本地与云酒馆通用，换设备、清缓存均不丢失。</p>
            </div>
        </div>`;
    }

    function renderNpcDetail(npcName) {
        return `
        <div class="ltm-card">
            <div class="ltm-card-title">
                <span class="ltm-title-left"><i class="fa-solid fa-id-card"></i> 「${esc(npcName)}」独立档案</span>
            </div>
            ${renderPartitionTabs()}
            <div id="ltm-part-content"></div>
        </div>`;
    }

    function renderPartContentOnly() {
        const agentId = getAgentId();
        if (!agentId) return;
        const container = document.getElementById('ltm-part-content');
        if (container) {
            container.innerHTML = renderPartitionContent(agentId, currentNpc);
        }
    }

    function bindViewEvents() {
        const body = document.getElementById('ltm-drawer-body');
        if (!body || body.dataset.bound) return;
        body.dataset.bound = '1';

        body.addEventListener('click', handleClick);
        body.addEventListener('change', handleChange);
        body.addEventListener('focusout', handleBlur);
    }

    function handleClick(e) {
        const agentId = getAgentId();
        const btn = e.target.closest('[data-act]');
        if (btn) {
            const act = btn.dataset.act;
            const part = btn.dataset.part;
            const idx = parseInt(btn.dataset.idx, 10);
            const npc = btn.dataset.npc || null;
            const npcName = currentNpc || npc;

            switch (act) {
                case 'del':
                    removePartitionItem(agentId, part, idx, npcName);
                    renderCurrentView();
                    break;
                case 'todo-done':
                    markTodoDone(agentId, idx, npcName);
                    renderCurrentView();
                    break;
                case 'clear-all':
                    if (confirm(`确定清空「${getCharName()}」的全部记忆吗？此操作不可恢复。`)) {
                        clearMemory(agentId);
                        renderCurrentView();
                    }
                    break;
                case 'del-npc':
                    if (confirm(`确定删除 NPC「${npc}」的独立记忆库吗？`)) {
                        removeNpc(agentId, npc);
                        renderCurrentView();
                    }
                    break;
                case 'add-npc': {
                    const name = prompt('请输入 NPC 名称：');
                    if (name && name.trim()) {
                        ensureNpcMemory(agentId, name.trim());
                        renderCurrentView();
                    }
                    break;
                }
                case 'add': {
                    if (part === 'important_items') {
                        addToPartition(agentId, part, { name: '新物品', significance: '物品描述……' });
                    } else if (part === 'emotional_tags') {
                        addToPartition(agentId, part, '新标签');
                    } else if (part === 'todos') {
                        addToPartition(agentId, part, { content: '新的待办事项', done: false });
                    } else {
                        addToPartition(agentId, part, '新条目');
                    }
                    renderCurrentView();
                    break;
                }
                case 'reset-prompt': {
                    resetPrompt(btn.dataset.key);
                    renderCurrentView();
                    break;
                }
                case 'save-all-prompts': {
                    saveAllPrompts();
                    renderCurrentView();
                    break;
                }
                case 'summarize-now': {
                    if (!agentId) {
                        showToast('请先选择角色卡');
                        break;
                    }
                    manualSummarizeAll(agentId);
                    break;
                }
            }
            return;
        }

        const pill = e.target.closest('[data-part].ltm-pill');
        if (pill) {
            currentPart = pill.dataset.part;
            document.querySelectorAll('#ltm-drawer-body .ltm-pill[data-part]').forEach((p) => {
                p.classList.toggle('ltm-active', p.dataset.part === currentPart);
            });
            renderPartContentOnly();
            return;
        }

        const charCard = e.target.closest('.ltm-char-card[data-char]');
        if (charCard) {
            const name = charCard.dataset.char;
            const detail = document.getElementById('ltm-memory-detail');
            if (detail) {
                detail.innerHTML = renderMemoryDetail(agentId, name);
                renderPartContentOnly();
            }
            return;
        }

        const npcCard = e.target.closest('.ltm-char-card[data-npc]');
        if (npcCard && !e.target.closest('[data-act]')) {
            const name = npcCard.dataset.npc;
            currentNpc = name;
            currentPart = 'key_events';
            const detail = document.getElementById('ltm-npc-detail');
            if (detail) {
                detail.innerHTML = renderNpcDetail(name);
                renderPartContentOnly();
            }
            return;
        }
    }

    function handleChange(e) {
        const el = e.target;
        if (el.matches('[data-setting]')) {
            const key = el.dataset.setting;
            if (el.type === 'checkbox') {
                setSetting(key, el.checked);
            } else if (el.dataset.value !== undefined) {
                setSetting(key, parseInt(el.dataset.value, 10) || 0);
            } else {
                setSetting(key, parseInt(el.value, 10) || 0);
            }
        }
    }

    function handleBlur(e) {
        const el = e.target;
        if (!el.matches('[data-editable]')) return;
        const agentId = getAgentId();
        if (!agentId) return;

        const part = el.dataset.part;
        const idx = parseInt(el.dataset.idx, 10);
        const field = el.dataset.field || null;
        const npcName = el.dataset.npc || null;

        const mem = npcName ? getNpcMemory(agentId, npcName) : getCharacterMemory(agentId);
        const arr = mem?.[part];
        if (!arr || idx < 0 || idx >= arr.length) return;

        const newText = el.innerText.trim();

        if (field === 'name' || field === 'significance') {
            let item = arr[idx];
            if (typeof item === 'string') item = { name: item, significance: '' };
            item[field] = newText;
            updatePartitionItem(agentId, part, idx, item, npcName);
        } else if (typeof arr[idx] === 'string' && field === null) {
            updatePartitionItem(agentId, part, idx, newText, npcName);
        } else if (typeof arr[idx] === 'object' && !field) {
            arr[idx].content = newText;
            updatePartitionItem(agentId, part, idx, arr[idx], npcName);
        }
    }

    function saveAllPrompts() {
        const items = document.querySelectorAll('#ltm-drawer-body .ltm-prompt-item');
        items.forEach((item) => {
            const key = item.dataset.promptKey;
            const system = item.querySelector('.ltm-prompt-system').value;
            const user = item.querySelector('.ltm-prompt-user').value;
            const nameEl = item.querySelector('.ltm-prompt-name');
            const name = nameEl ? nameEl.textContent.replace(/^\s*[^\s]+\s*/, '').trim() : '';
            savePrompt(key, { name, system, user });
        });
        showToast('提示词已保存到服务端');
    }

    function showToast(msg) {
        let t = document.getElementById('ltm-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'ltm-toast';
            t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:rgba(94,16,16,0.95);color:#f6f1e6;padding:10px 20px;border-radius:8px;z-index:40000;font-size:0.85rem;transition:opacity 0.3s;';
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.style.opacity = '1';
        clearTimeout(t._timer);
        t._timer = setTimeout(() => { t.style.opacity = '0'; }, 1800);
    }

    // =============================================================
    // 插件入口（事件绑定 + 注入逻辑）
    // =============================================================
    let pendingInjection = '';

    async function onMessageSent() {
        const settings = getSettings();
        if (!settings.enabled) return;
        const agentId = getAgentId();
        if (!agentId) return;

        const context = getSTContext();
        const chat = context?.chat || [];
        const lastUser = [...chat].reverse().find((m) => m.is_user);
        if (!lastUser) return;

        try {
            pendingInjection = await processUserMessage(String(lastUser.mes));
            log('注入提示词已就绪，长度：', pendingInjection.length);
        } catch (err) {
            console.warn('[LTM] 记忆处理失败：', err);
            pendingInjection = '';
        }
    }

    function injectPrompt(eventData) {
        const settings = getSettings();
        if (!settings.enabled || !settings.injectPrompt) return;
        if (!pendingInjection) return;

        const injection = pendingInjection;
        pendingInjection = '';

        const chat = eventData?.chat;
        if (!Array.isArray(chat)) return;

        chat.push({
            role: 'system',
            content: injection,
            is_system: true,
            force_avatar: false,
        });
    }

    function buildSettingsHtml() {
        const s = getSettings();
        return `
        <div class="ltm-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>长期记忆插件</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label">
                        <input type="checkbox" id="ltm_enabled" ${s.enabled ? 'checked' : ''}>
                        启用长期记忆（总开关）
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="ltm_inject" ${s.injectPrompt ? 'checked' : ''}>
                        注入记忆到提示词
                    </label>
                    <label>总结触发阈值（楼层数）
                        <input type="number" id="ltm_threshold" class="text_pole" min="5" value="${s.summaryThreshold}">
                    </label>
                    <label>保留最近活跃楼层数
                        <input type="number" id="ltm_keep" class="text_pole" min="1" value="${s.keepActiveFloors}">
                    </label>
                    <label>待办检查频率（每 N 轮）
                        <input type="number" id="ltm_todo" class="text_pole" min="1" value="${s.todoCheckInterval}">
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="ltm_debug" ${s.debug ? 'checked' : ''}>
                        调试日志
                    </label>
                    <div class="ltm-hint">
                        记忆数据自动保存到酒馆服务端，本地/云酒馆通用，无需本地存储。
                    </div>
                </div>
            </div>
        </div>`;
    }

    function bindSettingsEvents() {
        $('#ltm_enabled').on('change', function () { setSetting('enabled', this.checked); });
        $('#ltm_inject').on('change', function () { setSetting('injectPrompt', this.checked); });
        $('#ltm_threshold').on('input', function () { setSetting('summaryThreshold', parseInt(this.value) || 20); });
        $('#ltm_keep').on('input', function () { setSetting('keepActiveFloors', parseInt(this.value) || 5); });
        $('#ltm_todo').on('input', function () { setSetting('todoCheckInterval', parseInt(this.value) || 10); });
        $('#ltm_debug').on('change', function () { setSetting('debug', this.checked); });
    }

    function init() {
        getSettings();

        const context = getSTContext();
        const eventSource = context?.eventSource;
        const event_types = context?.event_types;

        // 设置面板
        if (typeof jQuery !== 'undefined' && typeof $('#extensions_settings') !== 'undefined') {
            $('#extensions_settings').append(buildSettingsHtml());
            bindSettingsEvents();
        }

        // 悬浮球管理面板
        mountPanelShell();

        // 事件绑定
        if (eventSource && event_types?.MESSAGE_SENT) {
            eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
        }
        if (eventSource && event_types?.CHAT_COMPLETION_PROMPT_READY) {
            eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, injectPrompt);
        }
        if (eventSource && event_types?.CHAT_CHANGED) {
            eventSource.on(event_types.CHAT_CHANGED, renderCurrentView);
        }

        console.log('[LTM] 长期记忆插件已加载（纯前端方案，服务端持久化）');
    }

    // ---------------------------------------------------------------------
    // 启动：SillyTavern 插件加载完成后 jQuery ready 时执行
    // ---------------------------------------------------------------------
    if (typeof jQuery !== 'undefined') {
        jQuery(init);
    } else {
        // 极端情况兜底：DOM 就绪后执行
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    // 暴露到全局，便于调试
    global.LTM = {
        PLUGIN_ID,
        PARTITIONS,
        getContext: getSTContext,
        getSettings,
        setSetting,
        getAgentId,
        getCharName,
        getCharacterMemory,
        getPartition,
        addToPartition,
        updatePartitionItem,
        removePartitionItem,
        clearMemory,
        markTodoDone,
        ensureNpcMemory,
        listNpcs,
        removeNpc,
        getNpcMemory,
        getAllPrompts,
        savePrompt,
        resetPrompt,
        processUserMessage,
        manualSummarizeAll,
        refreshPanel: renderCurrentView,
    };
})(typeof window !== 'undefined' ? window : globalThis);
