import json
import subprocess
import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


class DigitalWorkflowTest(unittest.TestCase):
    def test_narration_is_replanned_near_thirty_seconds(self):
        script = r"""
globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener:()=>{}, dispatchEvent:()=>{} };
globalThis.document = { querySelector:()=>null, querySelectorAll:()=>[] };
const m = await import('./js/views/chainWorkshop.js');
const shots = [55,55,80,70].map((n, i) => ({ line: String.fromCharCode(65 + i).repeat(n) + '。' }));
console.log(JSON.stringify(m.planDigitalNarrationSegments(shots).map(x => x.dur)));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        durations = json.loads(result.stdout.strip())
        self.assertEqual(durations, [22, 30])
        self.assertTrue(all(duration <= 30 for duration in durations))

    def test_cut_page_does_not_auto_compose_on_render(self):
        source = (APP_DIR / "js/views/chainCut.js").read_text(encoding="utf-8")
        self.assertNotIn("queueMicrotask(() => composeFinal", source)
        self.assertIn("audioTimingAttemptSig", source)
        self.assertIn("COMPOSE_TIMEOUT_MS", source)

    def test_creator_analytics_has_account_filter(self):
        source = (APP_DIR / "js/views/analyticsView.js").read_text(encoding="utf-8")
        self.assertIn('id="daAccountFilter"', source)
        self.assertIn("accountMatch", source)

    def test_subtitles_use_known_text_timing_and_manual_track_is_preserved(self):
        source = (APP_DIR / "js/views/chainCut.js").read_text(encoding="utf-8")
        workshop = (APP_DIR / "js/views/chainWorkshop.js").read_text(encoding="utf-8")
        productions = (APP_DIR / "js/domain/productions.js").read_text(encoding="utf-8")
        self.assertIn('mode: isDigitalHuman() ? "digital-human" : "info-flow"', source)
        self.assertIn("timedSpeechHintsForClip", source)
        self.assertIn("extractStructuredSpokenCues", source)
        self.assertIn("spreadKnownCaption", source)
        self.assertIn('"digital-segment-duration-v2"', source)
        self.assertIn('"prompt-speech-timeline-v3-manual"', source)
        self.assertIn('"known-narration-real-duration"', source)
        self.assertIn('"existing-prompt-spoken-timeline"', source)
        self.assertIn("promptTimelineCaptions", source)
        self.assertNotIn('/api/video/audio-timing', source)
        self.assertIn("audioTimingRevision", source)
        self.assertIn("timingAttemptIsCurrent", source)
        self.assertIn("clip.videoDuration = actual", source)
        self.assertNotIn("seg.audioDuration = actual", source)
        self.assertIn("invalidateDerivedMediaAfterDigitalAudioChange", workshop)
        self.assertIn("const audioSignature =", workshop)
        self.assertIn("audioAssetId: seg.audioAssetId", productions)
        self.assertIn("videoDuration:", productions)
        self.assertNotIn('subTimingSource = "estimated-material-v2"', source)
        self.assertNotIn("estimateInfoFlowCaptions", source)
        self.assertIn('s.text = e.target.value;\n      markCaptionTimingManual()', source)
        self.assertNotIn("script.shots?.[index]?.line", source)
        self.assertIn("STRICT_UI_QUOTE_CONTEXT", source)

    def test_infoflow_subtitles_are_manual_only_and_digital_default_is_15px(self):
        source = (APP_DIR / "js/views/chainCut.js").read_text(encoding="utf-8")
        self.assertIn("if (!isDigitalHuman() || queuedCaptionRealignment", source)
        self.assertIn("manualTrigger = false", source)
        self.assertIn("if (!isDigitalHuman() && !manualTrigger)", source)
        self.assertIn("alignCaptionsToAudio({ force: true, manualTrigger: true })", source)
        self.assertIn('digitalCaptionMode ? 15 : 11', source)
        self.assertIn("p.artifacts.subStyleUserEdited = true", source)
        self.assertIn('信息流默认不自动生成字幕', source)
        self.assertIn('endsWith("-manual")', source)

    def test_digital_caption_track_is_monotonic_and_inside_clip_duration(self):
        script = r"""
globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener:()=>{}, dispatchEvent:()=>{} };
globalThis.document = { querySelector:()=>null, querySelectorAll:()=>[], body:{ dataset:{} } };
const m = await import('./js/views/chainCut.js');
const timeline = [
  { id:'clip-1', segmentId:'seg-1', dur:3.2, audioDuration:3.2 },
  { id:'clip-2', segmentId:'seg-2', dur:4.4, audioDuration:4.4 }
];
const cues = m.buildDigitalSegmentDurationCaptions(timeline, [
  { id:'seg-1', line:'第一句很短。第二句接着说。' },
  { id:'seg-2', line:'字母 AI 和 OpenClaw 也必须保持原文。最后一句。' }
]);
console.log(JSON.stringify(cues));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        cues = json.loads(result.stdout.strip())
        self.assertGreaterEqual(len(cues), 2)
        self.assertTrue(all(cue["start"] >= 0 and cue["end"] > cue["start"] for cue in cues))
        self.assertTrue(all(cues[index]["end"] <= cues[index + 1]["start"] for index in range(len(cues) - 1)))
        self.assertLessEqual(cues[-1]["end"], 7.6)
        text = "".join(cue["text"] for cue in cues)
        self.assertIn("AI", text)
        self.assertIn("OpenClaw", text)

    def test_digital_segment_duration_fallback_uses_known_narration_only(self):
        script = r"""
globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener:()=>{}, dispatchEvent:()=>{} };
globalThis.document = { querySelector:()=>null, querySelectorAll:()=>[], body:{ dataset:{} } };
const m = await import('./js/views/chainCut.js');
const cues = m.buildDigitalSegmentDurationCaptions([
  { id:'clip-1', segmentId:'seg-1', dur:5, audioDuration:3 },
  { id:'clip-2', segmentId:'seg-2', dur:4, audioDuration:2 }
], [
  { id:'seg-1', line:'第一段清晰口播', videoPrompt:'绝不能进入字幕的导演说明' },
  { id:'seg-2', line:'第二段清晰口播' }
]);
const split = m.buildDigitalSegmentDurationCaptions([
  { id:'clip-a', segmentId:'seg-a', dur:5, trimIn:0, audioDuration:10 },
  { id:'clip-b', segmentId:'seg-a', dur:5, trimIn:5, audioDuration:10 }
], [{ id:'seg-a', line:'一二三四五六七八九十' }]);
const semantic = m.buildDigitalSegmentDurationCaptions([
  { id:'clip-semantic', segmentId:'seg-semantic', dur:6, audioDuration:6 }
], [{ id:'seg-semantic', line:'声音很重要，打开镜头我们开始看画面。' }]);
const alignedDigital = m.cleanAlignedCaptionText('声音很重要，打开镜头我们开始看画面。', true);
const alignedInfoFlow = m.cleanAlignedCaptionText('声音很重要，打开镜头我们开始看画面。', false);
console.log(JSON.stringify({ cues, split, semantic, alignedDigital, alignedInfoFlow }));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        payload = json.loads(result.stdout.strip())
        cues = payload["cues"]
        self.assertEqual([cue["text"] for cue in cues], ["第一段清晰口播", "第二段清晰口播"])
        self.assertEqual([(cue["start"], cue["end"]) for cue in cues], [(0, 3), (5, 7)])
        self.assertTrue(all(cue["digitalSegmentDuration"] for cue in cues))
        self.assertNotIn("导演说明", "".join(cue["text"] for cue in cues))
        split = payload["split"]
        self.assertEqual("".join(cue["text"] for cue in split), "一二三四五六七八九十")
        self.assertEqual([cue["clipId"] for cue in split], ["clip-a", "clip-b"])
        self.assertEqual([(cue["start"], cue["end"]) for cue in split], [(0, 5), (5, 10)])
        semantic_text = "".join(cue["text"] for cue in payload["semantic"]).replace(" ", "")
        self.assertEqual(semantic_text, "声音很重要打开镜头我们开始看画面")
        self.assertEqual(
            payload["alignedDigital"].replace(" ", ""),
            "声音很重要打开镜头我们开始看画面",
        )
        self.assertNotEqual(payload["alignedInfoFlow"], payload["alignedDigital"])
        source = (APP_DIR / "js/views/chainCut.js").read_text(encoding="utf-8")
        self.assertIn('"digital-segment-duration-v2"', source)
        self.assertIn('"digital-segment-duration-v2-empty"', source)
        self.assertIn("trustedNarration", source)
        digital_hint_start = source.index("function timedSpeechHintsForClip")
        infoflow_start = source.index("const segments = p.artifacts.boards?.infoFlow", digital_hint_start)
        hint_guard = source[digital_hint_start:infoflow_start]
        self.assertIn("if (isDigitalHuman())", hint_guard)
        self.assertIn("digitalSegmentDurationCuesForClip", hint_guard)
        self.assertIn("cleanTrustedNarrationCaption(timingText)", source)

    def test_infoflow_caption_hints_only_accept_explicit_spoken_source(self):
        script = r"""
globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener:()=>{}, dispatchEvent:()=>{} };
globalThis.document = { querySelector:()=>null, querySelectorAll:()=>[], body:{ dataset:{} } };
const m = await import('./js/views/chainCut.js');
const input = `0-3s 声音/台词：镜头快速推进，必须高级。
口播原话：“真正应该出现的口播”
3-6s 台词：这是导演占位文本
角色A说：“第二句真实对白”
3-6s 台词：字幕跟随口播精准出现
3-6s 声音/台词：不要使用机械播报感
3-6s 旁白：无字幕，不生成花字
随便引用“不要入字幕”`;
console.log(JSON.stringify(m.extractStructuredSpokenCues(input, 6)));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        self.assertEqual(json.loads(result.stdout.strip()), [
            {"text": "真正应该出现的口播", "start": 0, "end": 3},
            {"text": "第二句真实对白", "start": 3, "end": 6},
        ])

    def test_infoflow_caption_hints_accept_natural_quoted_speech_without_ui_copy(self):
        script = r"""
globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener:()=>{}, dispatchEvent:()=>{} };
globalThis.document = { querySelector:()=>null, querySelectorAll:()=>[], body:{ dataset:{} } };
const m = await import('./js/views/chainCut.js');
const input = `0-2s：输入框显示：“三个版本，下班前”，这里只是界面文字。
2-5s：他侧身躲闪，嘴角又急又无奈地说：“又压过来一摞，我还没理完上一摞。”
5-9s：角色扒开文件，喘了一口气说：“资料要看，步骤要拆，结果还要能交。”
9-12s：他皱着眉说：“三个版本，下班前。”
12-15s：角色把头靠在文件上，闷声说：“先别理了，让它先跑一版。”
禁止角色说：“这句是导演限制，不能成为字幕。”`;
console.log(JSON.stringify(m.extractStructuredSpokenCues(input, 15)));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        cues = json.loads(result.stdout.strip())
        expected = [
            (2, 5, "又压过来一摞我还没理完上一摞"),
            (5, 9, "资料要看步骤要拆结果还要能交"),
            (9, 12, "三个版本下班前"),
            (12, 15, "先别理了让它先跑一版"),
        ]
        for start, end, text in expected:
            actual = "".join(
                cue["text"].replace(" ", "") for cue in cues
                if cue["start"] >= start and cue["end"] <= end
            )
            self.assertEqual(actual, text)
        self.assertTrue(all(any(cue["start"] >= start and cue["end"] <= end for start, end, _ in expected) for cue in cues))
        self.assertNotIn("输入框", "".join(cue["text"] for cue in cues))

    def test_infoflow_dialogue_quotes_support_variable_spoken_prefixes_only(self):
        script = r"""
globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener:()=>{}, dispatchEvent:()=>{} };
globalThis.document = { querySelector:()=>null, querySelectorAll:()=>[], body:{ dataset:{} } };
const cut = await import('./js/views/chainCut.js');
const input = `0-3s：角色皱眉说:"这份表怎么又乱了？"
3-6s：口播自然扣回发布文案重点：“先把资料放到一起。”
6-9s：输入框显示：“整理资料”，按钮写着“生成”
9-12s：禁止角色说：“不应该出现”
12-15s：老板来一句“最后检查结果。”
15-18s：演员自言自语:"第三版到底是哪张图。"
18-21s：他呼出一口气:"每次都像重新开始。"
21-24s：领导的声音从画外传来:"月底报表今天必须交。"
24-27s：员工：“直接开工。”
27-30s：同事抬头：“这个版本可以。”
30-33s：产品经理看镜头：“先核对口径。”
33-36s：画面收束：“任务已完成”
36-39s：镜头收束：“不应出现”
39-42s：用户输入:"整理资料"
42-45s：用户点击按钮:"开始生成"
45-48s：角色外貌锚点:"鹅蛋脸"
48-51s：用户：“这句是真实口播。”
51-54s：小李扭头厉声:"这三个口径以哪个为准？"
54-57s：老周压低声音:"先把定义对一遍。"
57-60s：小李咬牙:"月底就要交了。"
60-63s：文件夹"啪"地落下，小李扭头厉声:"前面的音效不能打乱台词配对。"
63-66s：台词汇总：“直接开工。”“这个版本可以。”
66-69s：角色A外观:"鹅蛋脸"
69-72s：人物形象:"二十八岁职场人"
72-75s：主角性格:"沉稳克制"
75-78s：角色一致性:"保持同一服装"
78-81s：人物镜头设计:"中景推进"
81-84s：角色说话风格:"自然短促"
84-87s：员工服饰:"白色衬衫"
87-90s：界面把"口播要点"和“场控口令”拖入中央面板
90-93s：右侧"口播/场控"栏高亮“提示：商品顺序已变更”
93-96s：口播要点:"短促自然"
96-99s：口播场控栏:"自然口语"
99-102s：台词风格:"轻松幽默"
102-105s：口播自然扣回重点:"这句是明确口播。"`;
console.log(JSON.stringify({
  unchanged: input,
  cues: cut.extractStructuredSpokenCues(input, 105)
}));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        payload = json.loads(result.stdout.strip())
        self.assertIn('输入框显示：“整理资料”', payload["unchanged"])
        self.assertIn('演员自言自语:"第三版到底是哪张图。"', payload["unchanged"])
        expected = [
            (0, 3, "这份表怎么又乱了"), (3, 6, "先把资料放到一起"),
            (12, 15, "最后检查结果"), (15, 18, "第三版到底是哪张图"),
            (18, 21, "每次都像重新开始"), (21, 24, "月底报表今天必须交"),
            (24, 27, "直接开工"), (27, 30, "这个版本可以"),
            (30, 33, "先核对口径"), (48, 51, "这句是真实口播"),
            (51, 54, "这三个口径以哪个为准"), (54, 57, "先把定义对一遍"),
            (57, 60, "月底就要交了"), (60, 63, "前面的音效不能打乱台词配对"),
            (102, 105, "这句是明确口播"),
        ]
        for start, end, text in expected:
            actual = "".join(
                cue["text"].replace(" ", "") for cue in payload["cues"]
                if cue["start"] >= start and cue["end"] <= end
            )
            self.assertEqual(actual, text)
        self.assertTrue(all(any(cue["start"] >= start and cue["end"] <= end for start, end, _ in expected) for cue in payload["cues"]))

    def test_infoflow_dialogue_ignores_generic_colons_and_keeps_explicit_speech(self):
        script = r"""
globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener:()=>{}, dispatchEvent:()=>{} };
globalThis.document = { querySelector:()=>null, querySelectorAll:()=>[], body:{ dataset:{} } };
const cut = await import('./js/views/chainCut.js');

const quotedTimeline = `0-3s：员工拨开纸页，“这份我没签字。”
3-6s：主角喘气，“行，我自己收。”
6-9s：员工点击按钮，“提交成功”弹出`;
const explicitUnquoted = '0-3s：台词（员工，低声）：今天先核对字段。';
const directSpeech = `0-3s：他抬头皱眉朝镜头方向脱口而出"这堆线索谁先跟谁后跟啊？"。
3-6s：销售男子把卡片推开，摇头说"全是要跟的，哪个该先？"。`;
const mannerSpeech = `0-3s：近景，手持跟拍她的视线：她蹲下捡起写着'缺货'的便签，声音急促：'这周一刚改过吧？'；
3-6s：切换到'重复问题识别'面板微距特写：旁边弹出'负责人：店员A'。`;
const colonTimeline = `0-3s：客户拍桌子：你给我个说法！
3-6s：台词短促自然：先把口径对齐。
6-9s：界面标题：提交成功。
9-12s：光线：冷白顶光逐渐压低。
12-15s：用户点击按钮：开始生成。
15-18s：男声：先看证据。
18-21s：陈力低声说：下周还是这张纸。
21-24s：明确目标：收齐所有人进度。
24-27s：主角状态面板：负责人店员A。
27-30s：主角看着屏幕说：结果还是对不上。`;
const nestedTimeline = `0-15秒，一镜到底：0-4秒，桌面散落文件；4-8秒，演员翻开文件；8-12秒，演员冲向会议室；12-15秒，演员回到工位。光线混合办公日光与顶灯，无转场，对白只有：怎么又是去年的项目名。`;
const naturalVariants = `0-3s：小吴对着镜头念出原始口播，字数控制在18字以内：先拆开再追结果。
3-6s：旁白收束「先停下来，按清单来」。
6-9s：女职员贴在耳边说"行，我把酒店和会议都再改一版"。
9-12s：对方举着U盘：'这个是昨天那个终版吧？'
12-15s：阿骆推开椅子站起来：'那个是上周的终版。'
15-18s：小董捡起主持稿抬头：'姐姐，你手里那份不是最终版。'
18-21s：桌面摆满化妆品和提示牌，女主播皱眉说出'完了完了顺序全乱了'。`;
const argumentativeColon = `0-3s：甲方语气冷静地提出方案：我把整理这事交给百度搭子就行了。
3-6s：乙方身体前倾直接反驳：它怎么会懂那些乱七八糟的命名。`;
const naturalUnquoted = `0-2s：女性职员猛地抬头，嘴唇微张说又来；
2-5s：同事递来录音笔说刚结束的客户会议全程都在这里，她接过录音笔。
5-8s：她动作僵硬地转身说我的桌面已经装不下了；
8-11s：她肩膀压低说记一下周一上线前加三个字段。
11-14s：她转头对镜头方向说谁来把这些东西放进同一个地方；
14-17s：用户界面说明负责人字段已经更新。`;
const metadataAndUi = `0-3s：台词风格：短促自然。
3-6s：口播要点：先检查字段。
6-9s：界面提出方案：自动归档。
9-12s：界面显示一条聊天记录：用户说今天先核对字段。
12-15s：主角看着屏幕说：这句是真实台词。
15-18s：女设计师语气急促地说一句台词："这句只出现一次。"`;
console.log(JSON.stringify({
  cues: cut.extractStructuredSpokenCues(quotedTimeline, 9),
  explicitUnquoted,
  directSpeech,
  explicitCues: cut.extractStructuredSpokenCues(explicitUnquoted, 3),
  directCues: cut.extractStructuredSpokenCues(directSpeech, 6),
  mannerCues: cut.extractStructuredSpokenCues(mannerSpeech, 6),
  colonCues: cut.extractStructuredSpokenCues(colonTimeline, 30),
  nestedCues: cut.extractStructuredSpokenCues(nestedTimeline, 15),
  naturalCues: cut.extractStructuredSpokenCues(naturalVariants, 21),
  argumentativeCues: cut.extractStructuredSpokenCues(argumentativeColon, 6),
  naturalUnquotedCues: cut.extractStructuredSpokenCues(naturalUnquoted, 17),
  metadataAndUiCues: cut.extractStructuredSpokenCues(metadataAndUi, 18)
}));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        payload = json.loads(result.stdout.strip())
        def assert_segment_cues(key, expected):
            cues = payload[key]
            for start, end, text in expected:
                actual = "".join(
                    cue["text"].replace(" ", "") for cue in cues
                    if cue["start"] >= start and cue["end"] <= end
                )
                self.assertEqual(actual, text.replace(" ", ""), f"{key} {start}-{end}")
            self.assertTrue(all(
                any(cue["start"] >= start and cue["end"] <= end for start, end, _ in expected)
                for cue in cues
            ), key)

        assert_segment_cues("cues", [
            (0, 3, "这份我没签字"), (3, 6, "行 我自己收"),
        ])
        self.assertEqual(payload["explicitUnquoted"], '0-3s：台词（员工，低声）：今天先核对字段。')
        self.assertIn('脱口而出"这堆线索谁先跟谁后跟啊？"', payload["directSpeech"])
        self.assertEqual(payload["explicitCues"], [])
        assert_segment_cues("directCues", [
            (0, 3, "这堆线索谁先跟谁后跟啊"), (3, 6, "全是要跟的 哪个该先"),
        ])
        assert_segment_cues("mannerCues", [(0, 3, "这周一刚改过吧")])
        self.assertEqual(payload["nestedCues"], [])
        assert_segment_cues("naturalCues", [
            (3, 6, "先停下来 按清单来"),
            (6, 9, "行 我把酒店和会议都再改一版"), (9, 12, "这个是昨天那个终版吧"),
            (12, 15, "那个是上周的终版"), (15, 18, "姐姐 你手里那份不是最终版"),
            (18, 21, "完了完了顺序全乱了"),
        ])
        assert_segment_cues("argumentativeCues", [
            (0, 3, "我把整理这事交给百度搭子就行了"),
            (3, 6, "它怎么会懂那些乱七八糟的命名"),
        ])
        assert_segment_cues("naturalUnquotedCues", [
            (0, 2, "又来"), (2, 5, "刚结束的客户会议全程都在这里"),
            (5, 8, "我的桌面已经装不下了"), (8, 11, "记一下周一上线前加三个字段"),
            (11, 14, "谁来把这些东西放进同一个地方"),
        ])
        assert_segment_cues("metadataAndUiCues", [
            (12, 15, "这句是真实台词"), (15, 18, "这句只出现一次"),
        ])
        # 普通“标签：内容”不再作为信息流字幕依据；只有明确说话动作
        # 后面的内容可以在用户手动点击匹配时进入字幕轨。
        assert_segment_cues("colonCues", [
            (18, 21, "下周还是这张纸"),
            (27, 30, "结果还是对不上"),
        ])
        colon_text = "".join(cue["text"] for cue in payload["colonCues"])
        self.assertNotIn("你给我个说法", colon_text)
        self.assertNotIn("先把口径对齐", colon_text)
        self.assertNotIn("先看证据", colon_text)

    def test_infoflow_prompt_timeline_accepts_local_or_global_segment_ranges(self):
        script = r"""
globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener:()=>{}, dispatchEvent:()=>{} };
globalThis.document = { querySelector:()=>null, querySelectorAll:()=>[], body:{ dataset:{} } };
const m = await import('./js/views/chainCut.js');
const local = `0-3s：台词：“今天就把这件事做完。”
3-7s：旁：“然后检查最终结果。”`;
const global = `15-18秒：台词：“今天就把这件事做完。”
18-22秒：旁：“然后检查最终结果。”`;
console.log(JSON.stringify({
  local: m.extractStructuredSpokenCues(local, 15),
  global: m.extractStructuredSpokenCues(global, 15)
}));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        data = json.loads(result.stdout.strip())
        expected = [
            {"text": "今天就把这件事做完", "start": 0, "end": 3},
            {"text": "然后检查最终结果", "start": 3, "end": 7},
        ]
        self.assertEqual(data["local"], expected)
        self.assertEqual(data["global"], expected)

    def test_infoflow_director_source_avoids_raw_history_and_blind_style_prefix(self):
        source = (APP_DIR / "js/api/ai.js").read_text(encoding="utf-8")
        start = source.index("async generateInfoFlowCreativePlan")
        end = source.index("/* ---------- md / 自然语言", start)
        director = source[start:end]

        # Feeding as much as 900 characters of each old prompt back to the LLM
        # makes the previous plot act like a hidden continuation instruction.
        self.assertNotIn("String(value).slice(0, 900)", director)
        # Blindly prepending the style duplicates a model-supplied style line and
        # creates `。。` when visualStyle already carries terminal punctuation.
        self.assertNotIn(
            'plan.frontPrompt = `统一画面风格：${sharedStyle}。\\n${plan.frontPrompt}`',
            director,
        )
        self.assertNotIn(
            'plan.backPrompt = `统一画面风格：${sharedStyle}。\\n${plan.backPrompt}`',
            director,
        )

    def test_infoflow_original_quality_contract_is_not_tightened_by_subtitle_rules(self):
        source = (APP_DIR / "js/api/ai.js").read_text(encoding="utf-8")
        start = source.index("async generateInfoFlowCreativePlan")
        end = source.index("/* ---------- md / 自然语言", start)
        director = source[start:end]
        cleaner_start = source.index("function cleanInfoFlowDirectorText")
        cleaner_end = source.index("function withSharedInfoFlowStyle", cleaner_start)
        cleaner = source[cleaner_start:cleaner_end]

        self.assertIn("for (let attempt = 0; attempt < 2; attempt++)", director)
        self.assertIn("上一轮未通过原因", director)
        self.assertIn("这是唯一一次结构修复", director)
        self.assertIn("frontScenes 与 backScenes 必须各有至少 4 个真实镜头", director)
        self.assertIn("lastDraft.slice(0, 7000)", director)
        self.assertIn("temperature: attempt === 0 ? 0.75 : 0.35", director)
        self.assertIn("至少 4 个分时镜头；台词必须原创、短促、自然", director)
        self.assertIn("例如超写实、电影纪实、夸张舞台广告或高质感三维界面", director)
        for tightened in (
            "按每秒不超过",
            "全程无口播、旁白和对白",
            "每面建议 320-650",
            "人物身份只能从本次",
            "visualStyle 单独返回",
            "实际原话必须统一写成中文双引号",
            "hasUnquotedInfoFlowDialogue",
            "normalizeInfoFlowDialogueQuotes",
        ):
            self.assertNotIn(tightened, director)
        self.assertNotIn("sanitizeXhsText", cleaner)

    def test_infoflow_director_preserves_structure_and_summarizes_history(self):
        script = r"""
globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
globalThis.location = { origin:'http://127.0.0.1:8787', protocol:'http:', hostname:'127.0.0.1', port:'8787', hash:'' };
globalThis.window = { location:globalThis.location, addEventListener:()=>{}, dispatchEvent:()=>{} };
globalThis.document = { querySelector:()=>null, querySelectorAll:()=>[], body:{ dataset:{} } };

let queue = [];
let capturedBodies = [];
globalThis.fetch = async (_url, options = {}) => {
  capturedBodies.push(JSON.parse(options.body || '{}'));
  const next = queue.shift();
  if (!next) throw new Error('测试响应队列耗尽');
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ choices:[{ message:{ content:JSON.stringify(next) } }] })
  };
};

const { AI } = await import('./js/api/ai.js');
window.XingzhenConfig.endpoint = '/api/chat/completions';
window.XingzhenConfig.apiKey = 'unit-test-only';
window.XingzhenConfig.serverManaged = true;

const structuralResponse = {
  creativeAngle: '任务卡空间错位',
  visualStyle: '电影纪实质感。',
  frontPrompt: `统一画面风格：电影纪实质感。
0-3秒：第一张任务卡从桌面边缘滑入，冷白顶光在纸面形成细长反光，特写→拉出，展示办公桌与散落资料的空间关系。
3-7 秒：第一栏待办被蓝色便签逐项覆盖，侧面中景跟随便签移动，背景人物只保留模糊轮廓，文件夹沿桌角形成清晰纵深。
7—11秒：资料卡像多米诺骨牌连续倒下，低机位横移捕捉纸张、回形针和印章的真实材质，窗外自然光逐渐变暖，冲突持续升级。
11至15秒：所有卡片在桌面中央重新排成清单，俯拍镜头缓慢稳定下来，最后一张完成标记亮起，画面用干净留白完成反转。`,
  backPrompt: `统一画面风格：电影纪实质感。
0-3秒：竖屏桌面录屏进入资料选择页，文件卡从左侧依次滑入中央工作区，鼠标轨迹短促明确，界面保持低文字密度和真实阴影。
3-7 秒：右侧参数栏依次选择分类规则与输出格式，镜头只展示窗口、文件和流程卡，蓝色进度线沿底部平稳推进，按钮反馈清楚。
7—11秒：处理区把散乱资料转换为结构化清单与结果表格，局部放大字段对应关系，窗口层级、圆角和留白保持统一，不出现人物或手部。
11至15秒：完成页并排展示归档文件夹、复核清单和可导出报告，镜头轻微推近绿色完成状态，最后以清爽桌面窗口自然收束。`
};

const validRetryResponse = {
  creativeAngle: '第二次合法方案',
  visualStyle: '明亮纪实广告',
  frontPrompt: `0-3s：文件柜突然弹开，彩色文件夹沿地面滑向办公桌，广角镜头快速后退建立异常事件，自然窗光照亮纸张纹理与空间纵深。
3-6s：员工侧身避开文件夹，低机位跟拍鞋边和纸张移动，桌面上的计时器不断跳动，节奏紧张但动作关系清晰。
6-10s：散乱文件围成旋转圆环，镜头绕桌半圈后停在中央空白任务卡，冷暖光线随旋转逐步过渡，冲突达到最高点。
10-13s：任务卡自动展开为三步清单，所有文件按颜色进入对应收纳盒，中景稳定推进，纸张摩擦声逐渐减弱。
13-15s：俯拍桌面恢复整洁，最后一个完成勾亮起，员工松一口气退到虚焦背景，画面以留白和自然光收束。`,
  backPrompt: `0-3s：桌面应用打开文件选择窗口，多份资料卡依次进入任务区，竖屏录屏构图清晰，蓝白界面保持真实阴影与低文字密度。
3-6s：规则面板选择分类字段和输出格式，鼠标轨迹从左向右移动，按钮反馈、下拉菜单与步骤编号依次亮起。
6-10s：处理进度稳定前进，文件名、字段卡和结果表在三个窗口间流转，镜头局部放大关键状态但不展示人物或手部。
10-13s：复核页面突出遗漏提醒与来源对应关系，两栏结果清楚对齐，完成状态逐项点亮，窗口层级保持一致。
13-15s：导出页展示文件夹、清单和报告三种结果，镜头轻推绿色完成标记，界面自然淡出并回到整洁桌面。`
};

async function run(responses, previousPrompts = [], input = {}) {
  queue = [...responses];
  capturedBodies = [];
  const result = await AI.generateInfoFlowCreativePlan({
    title: input.title || '把零散资料整理成可复核结果',
    copy: input.copy || '先明确材料范围，再检查字段和遗漏项。',
    narration: input.narration || '我会先把材料放到一起，再核对字段和最终结果。',
    account: { platform:'视频号', tone:'自然可信' },
    previousPrompts
  });
  return { result, bodies:[...capturedBodies] };
}

const structural = await run([structuralResponse]);
const structuralText = `${structural.result.frontPrompt}\n${structural.result.backPrompt}`;

const historyDetail = '旧剧情完整镜头细节：红色雨伞绕着打印机旋转并撞倒咖啡杯。';
const fullHistoryMarker = 'FULL_OLD_STORY_SHOULD_NOT_BE_SENT_TO_MODEL';
const oldPrompt = `旧版关键词：雨伞、打印机、咖啡杯。\n${historyDetail.repeat(40)}\n${fullHistoryMarker}`;
const history = await run([validRetryResponse], [oldPrompt]);
const historyUser = history.bodies[0].messages.find(message => message.role === 'user')?.content || '';

const firstStep = await run([validRetryResponse], [], {
  title: '第一步先把资料范围说清楚',
  copy: '第一步核对文件来源，第二步再检查遗漏项。',
  narration: '我第一步会确认材料范围，然后再进入复核。'
});
const firstStepUser = firstStep.bodies[0].messages.find(message => message.role === 'user')?.content || '';

console.log(JSON.stringify({
  structural: {
    keepsFirstImage: structuralText.includes('第一张'),
    keepsFirstColumn: structuralText.includes('第一栏'),
    keepsCameraArrow: structuralText.includes('特写→拉出'),
    hasCorruptedOrdinal: /前排(?:张|栏)/.test(structuralText),
    frontStyleCount: (structural.result.frontPrompt.match(/统一画面风格/g) || []).length,
    backStyleCount: (structural.result.backPrompt.match(/统一画面风格/g) || []).length,
    hasDoublePeriod: structuralText.includes('。。')
  },
  history: {
    hasAvoidanceHint: /旧稿/.test(historyUser) && /重新构思|不沿用|避免重复/.test(historyUser),
    includesFullMarker: historyUser.includes(fullHistoryMarker),
    detailOccurrences: historyUser.split(historyDetail).length - 1,
    requestLength: historyUser.length
  },
  inputFidelity: {
    keepsFirstStep: firstStepUser.includes('第一步'),
    hasCorruptedFirstStep: firstStepUser.includes('前排步')
  }
}));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout.strip())
        self.assertTrue(data["structural"]["keepsFirstImage"])
        self.assertTrue(data["structural"]["keepsFirstColumn"])
        self.assertTrue(data["structural"]["keepsCameraArrow"])
        self.assertFalse(data["structural"]["hasCorruptedOrdinal"])
        self.assertEqual(data["structural"]["frontStyleCount"], 1)
        self.assertEqual(data["structural"]["backStyleCount"], 1)
        self.assertFalse(data["structural"]["hasDoublePeriod"])
        self.assertTrue(data["history"]["hasAvoidanceHint"])
        self.assertFalse(data["history"]["includesFullMarker"])
        self.assertLessEqual(data["history"]["detailOccurrences"], 1)
        self.assertLess(data["history"]["requestLength"], 1200)
        self.assertTrue(data["inputFidelity"]["keepsFirstStep"])
        self.assertFalse(data["inputFidelity"]["hasCorruptedFirstStep"])

    def test_infoflow_structured_scenes_are_normalized_and_true_shortage_fails_before_generation(self):
        script = r"""
globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
globalThis.location = { origin:'http://127.0.0.1:8787', protocol:'http:', hostname:'127.0.0.1', port:'8787', hash:'' };
globalThis.window = { location:globalThis.location, addEventListener:()=>{}, dispatchEvent:()=>{} };
globalThis.document = { querySelector:()=>null, querySelectorAll:()=>[], body:{ dataset:{} } };
let queue = [];
let calls = 0;
globalThis.fetch = async (_url, options = {}) => {
  calls += 1;
  const next = queue.shift();
  return { ok:true, status:200, text:async()=>'', json:async()=>({ choices:[{ message:{ content:JSON.stringify(next) } }] }) };
};
const { AI } = await import('./js/api/ai.js');
window.XingzhenConfig.endpoint = '/api/chat/completions';
window.XingzhenConfig.apiKey = 'unit-test-only';
window.XingzhenConfig.serverManaged = true;
const detail = i => ({
  start:[0,3,7,11][i], end:[3,7,11,15][i],
  shot:`镜头${i + 1}使用不同景别与稳定机位`,
  visual:`围绕本次资料核对主题推进第${i + 1}个真实动作，展示文件、空间、状态变化与清晰光影关系，绝不重复前一镜头`,
  audio:`第${i + 1}段环境声与原创短句`, transition:'自然转场'
});
const structured = {
  creativeAngle:'结构化资料追逐', visualStyle:'电影纪实广告质感',
  frontScenes:[0,1,2,3].map(detail), backScenes:[0,1,2,3].map(i => ({...detail(i), visual:`真实产品界面完成第${i + 1}步资料核对操作，只有窗口、文件、字段与进度状态，不出现人物或手部`}))
};
queue = [structured]; calls = 0;
const ok = await AI.generateInfoFlowCreativePlan({ title:'核对资料', copy:'把遗漏项检查清楚', account:{platform:'视频号'} });
const okCalls = calls;
const lone = { ...detail(0), visual:detail(0).visual.repeat(5) };
const short = { ...structured, frontScenes:[lone], backScenes:[lone] };
queue = [short, short]; calls = 0;
let failed = false;
try { await AI.generateInfoFlowCreativePlan({ title:'核对资料', copy:'把遗漏项检查清楚', account:{platform:'视频号'} }); }
catch (error) { failed = /缺少完整的分时镜头设计/.test(error.message); }
console.log(JSON.stringify({
  okCalls, front:(ok.frontPrompt.match(/镜头\d/g) || []).length,
  back:(ok.backPrompt.match(/镜头\d/g) || []).length,
  failed, repairCalls:calls
}));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR, text=True, capture_output=True, check=True,
        )
        data = json.loads(result.stdout.strip())
        self.assertEqual(1, data["okCalls"])
        self.assertGreaterEqual(data["front"], 4)
        self.assertGreaterEqual(data["back"], 4)
        self.assertTrue(data["failed"])
        self.assertEqual(2, data["repairCalls"])

    def test_old_account_classification_prompts_are_removed(self):
        active_paths = [
            APP_DIR / "js/api/prompts.js",
            APP_DIR / "js/api/ai.js",
            APP_DIR / "js/domain/accounts.js",
            APP_DIR / "js/agent/intent.js",
            APP_DIR / "js/agent/cards.js",
            APP_DIR / "js/agent/orchestrator.js",
            APP_DIR / "js/views/chainWorkshop.js",
        ]
        source = "\n".join(path.read_text(encoding="utf-8") for path in active_paths)
        for stale in ("宝妈", "宝爸", "职场效率", "家庭管理", "学生教培", "岗位垂类", "TAG_POOL", "tagsOf("):
            self.assertNotIn(stale, source)
        self.assertNotIn("qtags", (APP_DIR / "js/api/ai.js").read_text(encoding="utf-8"))
        self.assertFalse((APP_DIR / "js/data/xhsAccountsSeed.js").exists())
        for path in (
            APP_DIR / "js/data/accountProfilesSeed.js",
            APP_DIR / "js/core/migrate.js",
        ):
            self.assertNotIn("qtags", path.read_text(encoding="utf-8"), path)

    def test_creative_video_uses_one_sketch_storyboard_sheet_and_one_30_second_job(self):
        orchestrator = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")
        productions = (APP_DIR / "js/domain/productions.js").read_text(encoding="utf-8")
        providers = (APP_DIR / "js/api/providers.js").read_text(encoding="utf-8")
        server = (APP_DIR / "server/main.py").read_text(encoding="utf-8")
        accounts = (APP_DIR / "js/domain/accounts.js").read_text(encoding="utf-8")
        drawer = (APP_DIR / "js/views/prodDrawer.js").read_text(encoding="utf-8")
        cards = (APP_DIR / "js/agent/cards.js").read_text(encoding="utf-8")
        self.assertIn("AI.generateCreativeVideoPlan", orchestrator)
        self.assertIn("prepareCreativeVideoReferenceContext", orchestrator)
        self.assertIn("referenceContext: creativeReference.brief", orchestrator)
        self.assertIn("originalRefAssetIds: creativeReference.refIds", orchestrator)
        self.assertIn("统一参考图视觉锚点", orchestrator)
        self.assertIn("await imageProviderReadyForSubmit()", orchestrator)
        self.assertIn('["创意视频故事版", "素描分镜板", "image-2"', orchestrator)
        self.assertIn('`${p.id}-creative-storyboard-sheet`', orchestrator)
        self.assertIn('storyboardSheet: {', orchestrator)
        self.assertIn('A.sceneRefAssetIds = [sheet.assetId]', orchestrator)
        self.assertIn("creative: u.creativeVideo === true", orchestrator)
        self.assertIn("duration: u.creativeVideo ? Math.max(4, Math.min(30", orchestrator)
        self.assertIn('A.materialMode === "creativeVideo"', productions)
        self.assertIn('const storyboardSheetId = A.creativeVideo.storyboardSheet?.assetId || null', productions)
        self.assertIn('label: `${duration}s创意成片`', productions)
        self.assertIn('const originalVideoRefs = Array.isArray(A.creativeVideo.originalRefAssetIds)', productions)
        self.assertIn('const directVideoRefs = [...new Set([...storyboardRefs, ...originalVideoRefs])].slice(0, 9)', productions)
        self.assertIn('ratio: "16:9"', orchestrator)
        self.assertIn('maxDuration: 30', providers)
        self.assertIn('creative: creative === true', providers)
        self.assertIn("SEEDANCE_CREATIVE_MODEL", server)
        self.assertIn("if req.creative and unresolved_local_images", server)
        self.assertIn("creative_reference_rejected = True", server)
        self.assertIn("没有降级为纯文本出片", server)
        self.assertIn('a.mode === "图文" ? "图文组" : "视频号"', accounts)
        self.assertIn('[["generate", "1 生成"], ["review", "2 审核"]]', drawer)
        self.assertIn("data-storyboard-refine", drawer)
        self.assertIn("进入剪辑台", drawer)
        self.assertIn("素描故事板", drawer)
        self.assertIn("1 张多格故事板", drawer)
        self.assertIn('class="agc-creative-style-label"', cards)
        self.assertIn("故事板已生成", cards)
        self.assertIn("封面可预览", cards)
        self.assertIn("预览/调整封面", cards)
        self.assertNotIn("用于故事版和 30 秒创意视频提示词", cards)

    def test_image_transport_timeout_is_reconciled_instead_of_terminal_failure(self):
        backend = (APP_DIR / "server/main.py").read_text(encoding="utf-8")
        providers = (APP_DIR / "js/api/providers.js").read_text(encoding="utf-8")
        orchestrator = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")
        self.assertIn('"code": "IMAGE_PROVIDER_RESULT_UNKNOWN"', backend)
        self.assertIn('"providerCalled": True', backend)
        self.assertIn('error?.code === "IMAGE_PROVIDER_RESULT_UNKNOWN"', providers)
        self.assertIn("imageOperationStatus(ref)", providers)
        self.assertIn("creative.status = deferred ? \"pending\" : \"failed\"", orchestrator)
        self.assertIn("if (generationDeferred(e))", orchestrator)

    def test_final_compose_tracks_bgm_and_preserves_clip_voice(self):
        source = (APP_DIR / "js/views/chainCut.js").read_text(encoding="utf-8")
        backend = (APP_DIR / "server/main.py").read_text(encoding="utf-8")
        self.assertIn("finalVideoMixSig", source)
        self.assertIn("p.artifacts.finalVideoMixSig !== mixSignature()", source)
        self.assertIn("preserveClipAudio: isDigitalHuman()", source)
        self.assertIn("def _media_has_audio", backend)
        self.assertIn("amix=inputs=2:duration=longest", backend)
        self.assertIn('time.time_ns()', backend)

    def test_main_subtitle_path_has_no_whisper_and_dashboard_chat_stays_plain(self):
        backend = (APP_DIR / "server/main.py").read_text(encoding="utf-8")
        cut = (APP_DIR / "js/views/chainCut.js").read_text(encoding="utf-8")
        overview = (APP_DIR / "js/views/overview.js").read_text(encoding="utf-8")
        self.assertNotIn("whisper.cpp", backend.lower())
        self.assertNotIn("/api/video/audio-timing", backend)
        self.assertNotIn("/api/video/audio-timing", cut)
        self.assertIn("未生成猜测字幕", cut)
        self.assertIn("function plainAssistantText", overview)
        self.assertIn('data-view-select="account"', overview)
        self.assertIn("内容数据", overview)

    def test_cut_preview_disables_digital_human_audio_crossfade(self):
        source = (APP_DIR / "js/views/chainCut.js").read_text(encoding="utf-8")
        styles = (APP_DIR / "styles/views.css").read_text(encoding="utf-8")
        self.assertIn('id="cpVideoNext"', source)
        self.assertIn("const transition = 0", source)
        self.assertIn("transitionDuration: 0", source)
        self.assertIn('.cp-video-next', styles)

    def test_image_prompt_pipeline_has_no_fixed_office_fallback(self):
        source = (APP_DIR / "js/api/ai.js").read_text(encoding="utf-8")
        self.assertNotIn("文件资料归档、字段提取、整理前后变化", source)
        self.assertNotIn("发布文案主题是", source)
        self.assertNotIn("生成小红书笔记风格3:4尺寸图片", source)
        self.assertIn("最终发布标题和正文是图片内容的唯一事实来源", source)
        self.assertIn("stripImagePlanningInstructions(stripPromptScaffold", source)

    def test_single_image_prompt_only_keeps_color_and_art_style(self):
        script = r"""
const m = await import('./js/core/util.js');
const result = m.singleImageGenerationPrompt(
  '一张百度搭子和codex的对比图',
  '暖白#FFF7ED底，橙色强调，简笔画火柴人，四格排版，人物坐在桌前，圆角卡片和大标题'
);
console.log(result);
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        ).stdout.strip()
        self.assertTrue(result.startswith("一张百度搭子和codex的对比图\n视觉参考："))
        self.assertNotIn("四格排版", result)
        self.assertNotIn("人物坐在桌前", result)
        self.assertNotIn("圆角卡片", result)

    def test_batch_refine_and_creator_member_visibility_regressions(self):
        drawer = (APP_DIR / "js/views/prodDrawer.js").read_text(encoding="utf-8")
        orchestrator = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")
        settings = (APP_DIR / "js/views/settings.js").read_text(encoding="utf-8")
        router = (APP_DIR / "js/core/router.js").read_text(encoding="utf-8")
        analytics = (APP_DIR / "js/views/analyticsView.js").read_text(encoding="utf-8")
        self.assertIn("本张参考图", drawer)
        self.assertIn("data-ref-replace", drawer)
        self.assertIn("data-ref-remove", drawer)
        self.assertIn('hasOwnProperty.call(it, "refAssetIds")', orchestrator)
        self.assertIn('item.role !== "supplier_child"', settings)
        self.assertIn('id="apiUsagePanel"', settings)
        self.assertIn('loadApiUsage({ inPlace: true })', settings)
        self.assertIn('refreshApiUsagePanel()', settings)
        self.assertIn('api-usage-overview', settings)
        self.assertIn('api-usage-zero-members', settings)
        self.assertIn('row.voiceCalls', settings)
        self.assertIn('row.topicOutputs', settings)
        self.assertIn('details?.receiptRows', settings)
        self.assertIn('details?.unresolvedReceiptEvents', settings)
        self.assertIn('待核对 / 未知凭证', settings)
        self.assertIn('product-library-grid', settings)
        self.assertIn('renderCreatorProfile(root)', settings)
        self.assertIn('remote.memberProfile.uploadAvatar(file)', settings)
        self.assertIn('管理员后台会同步显示', settings)
        self.assertIn('const managementPages = new Set(["members", "products", "usage", "requests"])', settings)
        for management_page in ("members", "products", "usage", "requests"):
            self.assertIn(f'managementPage === "{management_page}"', settings)
        self.assertIn('if (managementPage === "requests") loadRequests()', settings)
        self.assertIn('if (managementPage === "usage") loadApiUsage()', settings)
        self.assertIn(
            "if (!supplierRole && entitlementByRoute[zone] && !hasEntitlement(entitlementByRoute[zone]))",
            router,
        )
        self.assertIn("<th>账号</th><th>发布标题</th>", analytics)

    def test_v84_assets_delivery_and_stable_first_render(self):
        assets = (APP_DIR / "js/views/assetsView.js").read_text(encoding="utf-8")
        delivery = (APP_DIR / "js/views/deliveryView.js").read_text(encoding="utf-8")
        analytics = (APP_DIR / "js/views/analyticsView.js").read_text(encoding="utf-8")
        voice = (APP_DIR / "js/views/voiceLab.js").read_text(encoding="utf-8")
        self.assertIn('["图片", "视频"].includes(a.type)', assets)
        self.assertIn("exportAndPurgeAccountFiles", assets)
        self.assertIn("await removeAsset(a.id)", assets)
        self.assertNotIn("data-dtab", delivery)
        self.assertIn('data-creator-select="account"', delivery)
        self.assertNotIn("lastDeliveryRemotePullAt", delivery)
        self.assertNotIn("lastAnalyticsRemotePullAt", analytics)
        self.assertNotIn("ensureProviderStatus(stableRerender)", voice)

    def test_global_asset_library_contract(self):
        assets_view = (APP_DIR / "js/views/assetsView.js").read_text(encoding="utf-8")
        cut = (APP_DIR / "js/views/chainCut.js").read_text(encoding="utf-8")
        accounts = (APP_DIR / "js/domain/accounts.js").read_text(encoding="utf-8")
        self.assertIn('const isGlobalLibrary = () => libraryMode === "backend"', assets_view)
        self.assertIn('Object.freeze({ key: "drafts", label: "草稿箱"', assets_view)
        self.assertIn('Object.freeze({ key: "shared", label: "账号资产"', assets_view)
        self.assertIn('Object.freeze({ key: "favorites", label: "收藏夹"', assets_view)
        self.assertIn('Object.freeze({ key: "backend", label: "后台素材"', assets_view)
        self.assertIn('data-backend-kind="bgm"', assets_view)
        self.assertIn('data-backend-kind="material"', assets_view)
        self.assertIn('searchAssets({ accountId: isGlobalLibrary() || isPersonalLibrary() ? "all" : fAcc', assets_view)
        self.assertIn('isGlobalLibrary() || isPersonalLibrary() ? "" : `<label class="select-shell account-select">', assets_view)
        self.assertIn("if (isGlobalLibrary() || isPersonalLibrary()) return `<div class=\"asset-grid\">", assets_view)
        self.assertIn('a.type === "音频"', assets_view)
        self.assertIn("收藏夹始终严格绑定当前成员", assets_view)
        self.assertIn("globalBgmAssets()", cut)
        self.assertIn('optgroup label="共享 BGM 库"', cut)
        self.assertIn("addAssetFromFile(null, file", cut)
        self.assertIn("preservedGlobalAssets", accounts)
        self.assertIn("inferAssetFileMeta", assets_view)
        self.assertIn('const isEditingMaterial = ["图片", "视频"].includes(type)', assets_view)
        self.assertIn('["剪辑素材", "共享剪辑素材", `${type}素材`]', assets_view)
        self.assertIn("松手加入剪辑素材", assets_view)
        self.assertIn("视频或图片", assets_view)

        script = r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
const { state } = await import('./js/core/store.js');
const { globalBgmAssets, isEditingMaterialAsset, searchAssets } = await import('./js/domain/assets.js');
state.ui.currentMemberId = 'current-member';
state.assets = [
  { id:'bgm-other', type:'音频', tags:['BGM'], name:'跨账号共享曲', accountId:'another-account', ownerId:'other-member', createdAt:1 },
  { id:'voice', type:'音频', tags:['口播音频'], name:'口播', accountId:'current-account', ownerId:'other-member', createdAt:2 },
  { id:'material-other', type:'视频', tags:['剪辑素材'], name:'共享镜头', accountId:'another-account', ownerId:'other-member', createdAt:3 },
  { id:'material-image', type:'图片', tags:['共享剪辑素材', '图片素材'], name:'共享画面', accountId:'another-account', ownerId:'other-member', createdAt:4 },
  { id:'plain-image', type:'图片', tags:[], name:'他人私有图片', accountId:'another-account', ownerId:'other-member', createdAt:5 }
];
console.log(JSON.stringify({
  bgm: globalBgmAssets().map(item => item.id),
  materialVideo: isEditingMaterialAsset(state.assets[2]),
  materialImage: isEditingMaterialAsset(state.assets[3]),
  globallyVisible: searchAssets({ accountId:'all' }).map(item => item.id)
}));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        ).stdout.strip()
        self.assertEqual(
            '{"bgm":["bgm-other"],"materialVideo":true,"materialImage":true,'
            '"globallyVisible":["bgm-other","material-other","material-image"]}',
            result,
        )

    def test_empty_or_generic_mime_media_uses_filename_fallback(self):
        script = r"""
const storage = new Map();
globalThis.localStorage = {
  getItem(key){ return storage.get(key) || ""; },
  setItem(key, value){ storage.set(key, String(value)); },
  removeItem(key){ storage.delete(key); }
};
globalThis.sessionStorage = { getItem(){ return null; }, setItem(){} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener(){}, dispatchEvent(){} };

let uploadRequest = null;
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  const method = String(options.method || "GET").toUpperCase();
  if (url === "/api/health") {
    return new Response(JSON.stringify({ ok:true }), {
      status:200,
      headers:{ "Content-Type":"application/json" }
    });
  }
  if (url.startsWith("/api/files/") && method === "PUT") {
    const parsed = new URL(url, globalThis.location.origin);
    uploadRequest = {
      headerMime: options.headers["Content-Type"],
      bodyMime: options.body.type,
      queryMime: parsed.searchParams.get("mime"),
    };
    return new Response(JSON.stringify({
      fileUrl:"/api/files/voice.m4a",
      mime:"application/octet-stream",
      name:"voice.m4a",
      size:options.body.size
    }), {
      status:200,
      headers:{ "Content-Type":"application/json" }
    });
  }
  if (url.startsWith("/api/files/") && method === "GET") {
    return new Response(
      new Blob([new Uint8Array([9, 8, 7])], { type:"application/octet-stream" }),
      { status:200, headers:{ "Content-Type":"application/octet-stream" } }
    );
  }
  return new Response("{}", {
    status:200,
    headers:{ "Content-Type":"application/json" }
  });
};

const { db } = await import('./js/core/db.js');
const remote = await import('./js/core/remote.js');
const { state } = await import('./js/core/store.js');
const {
  addAssetFromFile,
  assetBlob,
  assetU8,
  inferAssetFileMeta
} = await import('./js/domain/assets.js');
const cases = [
  { name:'voice.mp3', type:'' },
  { name:'voice.wav', type:'' },
  { name:'voice.m4a', type:'application/octet-stream' },
  { name:'clip.mp4', type:'' },
  { name:'clip.mov', type:'' },
  { name:'fake.mp3', type:'video/mp4' }
];

const blobs = new Map();
db.putBlob = async (id, blob) => { blobs.set(id, blob); };
db.getBlob = async id => blobs.get(id) || null;
state.assets = [];
state.ui.assetSeq = 0;
state.ui.currentMemberId = "member-mime-test";
remote.setToken("test-token");
await remote.init();

const file = new File(
  [new Uint8Array([1, 2, 3, 4])],
  "voice.m4a",
  { type:"application/octet-stream" }
);
const asset = await addAssetFromFile(null, file, {
  tags:["参考音频库"],
  forceNew:true
});
const storedAfterAdd = blobs.get(asset.id);

blobs.delete(asset.id);
const fetchedBlob = await assetBlob(asset.id);
const storedAfterFetch = blobs.get(asset.id);

// 兼容旧 IndexedDB：即使库里仍残留通用 MIME，导出也必须使用有效的资产 MIME。
blobs.set(
  asset.id,
  new Blob([new Uint8Array([5, 6])], { type:"application/octet-stream" })
);
const exported = await assetU8(asset.id);

console.log(JSON.stringify({
  inferred: cases.map(inferAssetFileMeta),
  storedAfterAddMime: storedAfterAdd.type,
  uploadRequest,
  assetMime: asset.mime,
  fetchedMime: fetchedBlob.type,
  storedAfterFetchMime: storedAfterFetch.type,
  exportExt: exported.ext,
  exportBytes: Array.from(exported.u8),
}));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        ).stdout.strip()
        payload = json.loads(result)
        self.assertEqual(
            [
                {"mime": "audio/mpeg", "type": "音频"},
                {"mime": "audio/wav", "type": "音频"},
                {"mime": "audio/mp4", "type": "音频"},
                {"mime": "video/mp4", "type": "视频"},
                {"mime": "video/quicktime", "type": "视频"},
                {"mime": "video/mp4", "type": "视频"},
            ],
            payload["inferred"],
        )
        self.assertEqual("audio/mp4", payload["storedAfterAddMime"])
        self.assertEqual(
            {
                "headerMime": "audio/mp4",
                "bodyMime": "audio/mp4",
                "queryMime": "audio/mp4",
            },
            payload["uploadRequest"],
        )
        self.assertEqual("audio/mp4", payload["assetMime"])
        self.assertEqual("audio/mp4", payload["fetchedMime"])
        self.assertEqual("audio/mp4", payload["storedAfterFetchMime"])
        self.assertEqual("mp4", payload["exportExt"])
        self.assertEqual([5, 6], payload["exportBytes"])

    def test_mp3_alias_and_cross_library_dedup_keep_bgm_visible(self):
        script = r"""
globalThis.localStorage = { getItem(){ return ""; }, setItem(){}, removeItem(){} };
globalThis.sessionStorage = { getItem(){ return ""; }, setItem(){} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener(){}, dispatchEvent(){} };

const { db } = await import('./js/core/db.js');
const { state } = await import('./js/core/store.js');
const {
  addAssetFromFile,
  globalBgmAssets,
  inferAssetFileMeta,
  isBgmAsset
} = await import('./js/domain/assets.js');

const blobs = new Map();
db.putBlob = async (id, blob) => { blobs.set(id, blob); };
db.replaceAll = async () => {};
state.assets = [];
state.accounts = [];
state.ui.assetSeq = 0;
state.ui.currentMemberId = 'drop-owner';

const bytes = new Uint8Array([1, 2, 3, 4]);
const reference = await addAssetFromFile(null, new File(
  [bytes],
  '语音_070435.mp3',
  { type:'audio/mp3' }
), { tags:['参考音频库', '声线参考'] });
const bgm = await addAssetFromFile(null, new File(
  [bytes],
  '语音_070435.mp3',
  { type:'audio/x-mp3' }
), { tags:['BGM', '音乐'] });
const repeated = await addAssetFromFile(null, new File(
  [bytes],
  '语音_070435.mp3',
  { type:'audio/mpeg' }
), { tags:['BGM', '音乐'] });

console.log(JSON.stringify({
  inferred: [
    inferAssetFileMeta({ name:'track.mp3', type:'audio/mp3' }),
    inferAssetFileMeta({ name:'track.mp3', type:'audio/x-mp3' })
  ],
  assetCount: state.assets.length,
  separateLibraryAssets: reference.id !== bgm.id,
  repeatedBgmReused: repeated.id === bgm.id,
  bgmVisible: isBgmAsset(bgm),
  bgmIds: globalBgmAssets().map(asset => asset.id),
  storedMime: blobs.get(bgm.id)?.type || '',
  referenceTags: reference.tags,
  bgmTags: bgm.tags
}));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        ).stdout.strip()
        payload = json.loads(result)
        self.assertEqual(
            [
                {"mime": "audio/mpeg", "type": "音频"},
                {"mime": "audio/mpeg", "type": "音频"},
            ],
            payload["inferred"],
        )
        self.assertEqual(2, payload["assetCount"])
        self.assertTrue(payload["separateLibraryAssets"])
        self.assertTrue(payload["repeatedBgmReused"])
        self.assertTrue(payload["bgmVisible"])
        self.assertEqual(1, len(payload["bgmIds"]))
        self.assertEqual("audio/mpeg", payload["storedMime"])
        self.assertEqual(["参考音频库", "声线参考"], payload["referenceTags"])
        self.assertEqual(["BGM", "音乐"], payload["bgmTags"])

    def test_asset_library_rejects_duplicate_name_with_precise_error(self):
        script = r"""
globalThis.localStorage = { getItem(){ return ""; }, setItem(){}, removeItem(){} };
globalThis.sessionStorage = { getItem(){ return ""; }, setItem(){} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener(){}, dispatchEvent(){} };

const { state } = await import('./js/core/store.js');
const { addAssetFromFile } = await import('./js/domain/assets.js');
state.assets = [{
  id:'existing-bgm',
  name:'晨光配乐',
  type:'音频',
  tags:['BGM', '音乐'],
  ownerId:'drop-owner'
}];
state.ui.currentMemberId = 'drop-owner';
let message = '';
try {
  await addAssetFromFile(null, new File(
    [new Uint8Array([1, 2, 3])],
    '  晨光配乐.mp3',
    { type:'audio/mpeg' }
  ), {
    tags:['BGM', '音乐'],
    rejectDuplicateName:true,
    libraryLabel:'BGM 库'
  });
} catch (error) {
  message = error.message;
}
console.log(JSON.stringify({ message, assetCount:state.assets.length }));
"""
        payload = json.loads(subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        ).stdout.strip())
        self.assertEqual(1, payload["assetCount"])
        self.assertEqual(
            "“晨光配乐”已存在于BGM 库，请重命名文件后再添加",
            payload["message"],
        )
        assets_view = (APP_DIR / "js/views/assetsView.js").read_text(encoding="utf-8")
        self.assertIn("rejectDuplicateName: true", assets_view)
        self.assertIn('toast(error?.message || "素材加入失败，请稍后重试", "error")', assets_view)

    def test_asset_library_real_file_drop_classifies_bgm_video_and_image(self):
        script = r"""
const storage = new Map();
globalThis.localStorage = {
  getItem(key){ return storage.get(key) || ""; },
  setItem(key, value){ storage.set(key, String(value)); },
  removeItem(key){ storage.delete(key); }
};
globalThis.sessionStorage = { getItem(){ return null; }, setItem(){} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener(){}, dispatchEvent(){} };

const { db } = await import('./js/core/db.js');
const { state } = await import('./js/core/store.js');
const {
  addAssetFromFile,
  inferAssetFileMeta,
  isBgmAsset,
  isEditingMaterialAsset,
  searchAssets
} = await import('./js/domain/assets.js');

const blobs = new Map();
db.putBlob = async (id, blob) => { blobs.set(id, blob); };
db.getBlob = async id => blobs.get(id) || null;
db.replaceAll = async () => {};

state.assets = [];
state.accounts = [];
state.ui.assetSeq = 0;
state.ui.currentMemberId = 'drop-owner';

const droppedFiles = [
  new File([new Uint8Array([1, 2, 3])], 'track.mp3', { type:'application/octet-stream' }),
  new File([new Uint8Array([4, 5, 6])], 'clip.mov', { type:'' }),
  new File([new Uint8Array([7, 8, 9])], 'poster.gif', { type:'application/octet-stream' })
];

for (const file of droppedFiles) {
  const meta = inferAssetFileMeta(file);
  const tags = meta.type === '音频'
    ? ['BGM', '音乐']
    : ['剪辑素材', '共享剪辑素材', `${meta.type}素材`];
  await addAssetFromFile(null, file, { tags, forceNew:true });
}

state.assets.forEach(asset => { asset.ownerId = 'other-member'; });
console.log(JSON.stringify({
  assets: state.assets.map(asset => ({
    name: asset.name,
    type: asset.type,
    mime: asset.mime,
    tags: asset.tags,
    storedMime: blobs.get(asset.id)?.type || '',
    bgm: isBgmAsset(asset),
    material: isEditingMaterialAsset(asset)
  })),
  globallyVisible: searchAssets({ accountId:'all' }).map(asset => asset.name)
}));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        ).stdout.strip()
        payload = json.loads(result)
        self.assertEqual(
            [
                {
                    "name": "track",
                    "type": "音频",
                    "mime": "audio/mpeg",
                    "tags": ["BGM", "音乐"],
                    "storedMime": "audio/mpeg",
                    "bgm": True,
                    "material": False,
                },
                {
                    "name": "clip",
                    "type": "视频",
                    "mime": "video/quicktime",
                    "tags": ["剪辑素材", "共享剪辑素材", "视频素材"],
                    "storedMime": "video/quicktime",
                    "bgm": False,
                    "material": True,
                },
                {
                    "name": "poster",
                    "type": "图片",
                    "mime": "image/gif",
                    "tags": ["剪辑素材", "共享剪辑素材", "图片素材"],
                    "storedMime": "image/gif",
                    "bgm": False,
                    "material": True,
                },
            ],
            payload["assets"],
        )
        self.assertEqual(["track", "clip", "poster"], payload["globallyVisible"])

    def test_v84_subtitle_editor_review_and_dashboard_contract(self):
        cut = (APP_DIR / "js/views/chainCut.js").read_text(encoding="utf-8")
        review = (APP_DIR / "js/views/chainCopy.js").read_text(encoding="utf-8")
        overview = (APP_DIR / "js/views/overview.js").read_text(encoding="utf-8")
        assets = (APP_DIR / "js/views/assetsView.js").read_text(encoding="utf-8")
        studio = (APP_DIR / "js/views/studio.js").read_text(encoding="utf-8")
        agent = (APP_DIR / "js/agent/view.js").read_text(encoding="utf-8")
        self.assertIn("const totalDur = () => Math.max(1, clipsTotal())", cut)
        self.assertIn("function splitSubtitle", cut)
        self.assertIn("function pasteSubtitle", cut)
        self.assertIn('id="tlSubSplit"', cut)
        self.assertIn("video-review-grid", review)
        self.assertIn("封面图", review)
        self.assertIn("overview-integrated", overview)
        self.assertNotIn('data-overview-detail="published"><span>发布数量</span>', overview)
        self.assertIn('data-overview-detail="publishedPlatforms"', overview)
        self.assertIn('data-overview-detail="views"', overview)
        self.assertIn('内容数据 · ${accountViewRows.length} 个账号', overview)
        self.assertIn('data-view-filter-kind=', overview)
        self.assertIn('data-view-custom-date=', overview)
        self.assertIn('data-view-select="account"', overview)
        self.assertIn('data-view-select="creator"', overview)
        self.assertIn('data-view-number="minViews"', overview)
        self.assertIn('data-view-number="maxViews"', overview)
        self.assertIn('const analyticsByAssetId = new Map', overview)
        self.assertIn('const viewRows = delivered.map(({ asset, acc }) =>', overview)
        self.assertIn('const manualViews = Math.max(0, Number(asset.viewCount || 0));', overview)
        self.assertIn('const manualExposure = Math.max(0, Number(asset.exposureCount || 0));', overview)
        self.assertIn('const accountViewRows = accounts.map(acc =>', overview)
        self.assertNotIn('acc.totalViewCountOverride', overview)
        self.assertIn('views: derivedViews', overview)
        self.assertIn('exposure: derivedExposure', overview)
        self.assertIn('overview-view-filterbar', overview)
        self.assertIn('overview-interaction-row', overview)
        self.assertIn('创作人 ${esc(item.creator)}', overview)
        self.assertIn("发布数量明细", overview)
        self.assertIn("overview-donut", overview)
        self.assertIn("overview-trend-line", overview)
        self.assertIn("overview-trend-scroll", overview)
        self.assertIn('data-trend-date=', overview)
        self.assertIn('data-recent-filter-type=', overview)
        self.assertIn('data-trend-scroll-by=', overview)
        self.assertIn('data-overview-trend-window="30"', overview)
        self.assertIn("overviewTrendWindow", overview)
        self.assertIn("data-apply-overview-trend-range", overview)
        self.assertIn("data-recent-custom-date", overview)
        self.assertNotIn("overview-flow-card", overview)
        self.assertIn("openDeliveryRemarks", overview)
        self.assertNotIn('data-account-carousel', overview)
        self.assertIn("trendArea", overview)
        self.assertIn("overviewTrendFill", overview)
        self.assertIn("图文 ${item.image} · 视频 ${item.video}", overview)
        self.assertIn("homepageUrl", overview)
        self.assertIn("publishedPlatformRows", overview)
        self.assertIn("publishedPlatformSummary", overview)
        self.assertIn("publishedXhs.tooltip", overview)
        self.assertIn("publishedVideo.tooltip", overview)
        self.assertIn('data-overview-detail="publishedPlatforms"', overview)
        self.assertIn('<section class="overview-summary-grid"', overview)
        self.assertIn('<header><b>播放量分布</b><em>${accountViewRows.length} 个账号</em></header>', overview)
        self.assertIn('<header><b>发布量分布</b><em>${published.length} 条发布</em></header>', overview)
        self.assertIn('<button class="overview-donut-center" type="button" data-overview-detail="publishedPlatforms"><b>${published.length}</b><em>已发布</em></button>', overview)
        self.assertIn("overview-remark-preview", overview)
        self.assertIn('<article class="overview-viz-card overview-trend-card">', overview)
        self.assertNotIn('<header><b>平台分布</b><em>${delivered.length} 条交付</em></header>', overview)
        self.assertIn('data-overview-platform="小红书"', overview)
        self.assertIn('data-overview-platform="视频号"', overview)
        self.assertIn("overview-donut-segment is-xhs", overview)
        self.assertIn("overview-donut-segment is-video", overview)
        self.assertNotIn("overview-kpi-strip", overview)
        self.assertNotIn("overview-kpi-card", overview)
        self.assertNotIn('data-overview-detail="todo"', overview)
        self.assertNotIn("overview-account-strip", overview)
        self.assertIn('<details class="overview-view-account">', overview)
        self.assertNotIn('<details class="overview-view-account" open>', overview)
        self.assertIn('class="overview-view-link"', overview)
        self.assertIn('target="_blank" rel="noopener noreferrer">跳转链接</a>', overview)
        self.assertIn('<span>链接</span></div>', overview)
        self.assertNotIn("data-dashboard-mode", overview)
        self.assertNotIn("analyticsView.render(host, { embedded: true })", overview)
        self.assertIn('Object.freeze({ key: "drafts", label: "草稿箱", shortLabel: "草稿箱" })', assets)
        self.assertIn('libraryMode = "drafts"', assets)
        self.assertNotIn("去发布清单", assets)
        self.assertIn('const showRoleRef = acc.mode === "视频"', studio)
        self.assertIn('data-sh-ref="role"', studio)
        self.assertNotIn('data-sh-ref="style"', studio)
        self.assertIn('id="agwNewPanel"', agent)

    def test_account_profile_seed_only_bootstraps_an_empty_account_store(self):
        main = (APP_DIR / "js/main.js").read_text(encoding="utf-8")
        dialog = (APP_DIR / "js/views/accountDialog.js").read_text(encoding="utf-8")
        index = (APP_DIR / "index.html").read_text(encoding="utf-8")
        self.assertIn("async function bootstrapAccountProfilesIfEmpty", main)
        self.assertIn("if ((state.accounts || []).length || state.ui.accountProfileVersion) return 0;", main)
        self.assertNotIn("cleanupNonSeedAccounts", main)
        self.assertNotIn("applyAccountProfileSeed", main)
        self.assertNotIn("preserveManualStyle", main)
        self.assertNotIn('remote.deleteDoc("accounts"', main)
        self.assertIn("styleEditedAt: isSupplierManager ? (editing?.styleEditedAt || Date.now()) : Date.now()", dialog)
        self.assertIn('const APP_BUILD_ID = "20260817-v1436-token-plan-knowledge-2"', main)
        self.assertIn('js/main.js?v=20260817-v1436-token-plan-knowledge-2', index)
        self.assertIn('const syncDataBtn = $("#topSyncAnalytics")', main)
        self.assertIn("syncDataBtn?.remove();", main)
        self.assertNotIn("syncHomepageAnalytics", main)
        self.assertNotIn("refreshAllAnalytics", main)

    def test_batch_reference_images_are_explicit_and_title_changes_refresh_copy(self):
        orchestrator = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")
        view = (APP_DIR / "js/agent/view.js").read_text(encoding="utf-8")
        boards = (APP_DIR / "js/views/chainBoards.js").read_text(encoding="utf-8")

        image_refs = orchestrator.split("function imageRefGroupsFor", 1)[1].split("async function imageRefsForIds", 1)[0]
        self.assertNotIn("accountDefaultRefIds", image_refs)
        self.assertNotIn("imageStyleAssetId", image_refs)
        self.assertIn("it.refAssetIds = [...refGroups.all]", orchestrator)
        self.assertIn("function batchCoverRefIds", orchestrator)
        self.assertIn("function batchSceneRefIds", orchestrator)
        self.assertIn('batch?.contentKind === "material" ? batchCoverRefIds(batch, accountId) : []', orchestrator)
        self.assertIn('p.subType === "数字人" ? account?.charBoardAssetId : null', orchestrator)
        self.assertNotIn("accountDefaultRefIds", orchestrator)
        self.assertNotIn("if (!A.omniRefAssetIds.length && !p.batchId)", orchestrator)
        self.assertIn("!p.batchId ? A.sharedRefAssetId : null", orchestrator)
        self.assertIn("resetPlanReferences(payload)", view)
        self.assertIn("plan.sharedRefAssetIds = []", orchestrator)
        self.assertIn("plan.coverRefAssetIds = []", orchestrator)
        self.assertIn("plan.accountRefAssetIds = {}", orchestrator)

        self.assertIn("按标题生成正文与图卡提示词", boards)
        self.assertIn("const titleChanged = Boolean(previousGeneratedTitle && previousGeneratedTitle !== title)", boards)
        self.assertIn("const shouldGenerateBody = !body || titleChanged", boards)
        self.assertIn("if (shouldGenerateBody)", boards)
        self.assertIn("A.copyGeneratedForTitle = title", boards)

        script = r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
const { state } = await import('./js/core/store.js');
const { createProduction, buildMaterialUnits } = await import('./js/domain/productions.js');
const { createUnitVideoJobs } = await import('./js/agent/orchestrator.js?v=20260718-v94-1');
state.accounts = [{ id:'material-account', name:'素材号', mode:'视频', subType:'无数字人', platform:'视频号' }];
state.assets = [{ id:'old-hidden-ref', accountId:'material-account', type:'图片', name:'旧产品统一参考', tags:['统一参考','产品'] }];
state.productions = [];
state.jobs = [];
state.ui.currentMemberId = 'tester';
const p = createProduction({ accountId:'material-account', topic:'测试', batchId:'batch-1' });
p.artifacts.script.shots = [{ scene:1, idea:'演示', visual:'产品界面演示', line:'测试旁白', ui:true }];
p.artifacts.audio.perShot = [{ dur:5 }];
p.artifacts.audio.duration = 5;
const units = buildMaterialUnits(p);
units[0].videoPrompt = '9:16竖屏，5秒，展示产品界面。';
p.artifacts.boards.omniRefAssetIds = [];
p.artifacts.boards.sceneRefAssetIds = [];
createUnitVideoJobs(p);
console.log(JSON.stringify(state.jobs.map(job => job.refAssetIds)));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        ).stdout.strip()
        self.assertEqual("[[]]", result)

    def test_placeholder_bgm_style_and_topic_pools_are_removed(self):
        prompts = (APP_DIR / "js/api/prompts.js").read_text(encoding="utf-8")
        ai = (APP_DIR / "js/api/ai.js").read_text(encoding="utf-8")
        for stale in (
            "BGM_POOL",
            "STYLE_CHIP_BASE",
            "STYLE_POOL",
            "TOPIC_POOL",
            "轻快办公节拍",
            "一句话整理一周工作记录",
            "小红书种草风",
        ):
            self.assertNotIn(stale, prompts + ai)
        self.assertIn("PRODUCT_CATALOG_SEED", ai)
        self.assertIn("relatedProducts", ai)
        self.assertIn("account?.styleProfile || account?.lockedStyle", ai)

    def test_v1418_account_data_supplier_filters_and_baige_catalog_contract(self):
        main = (APP_DIR / "js/main.js").read_text(encoding="utf-8")
        home = (APP_DIR / "js/views/home.js").read_text(encoding="utf-8")
        delivery = (APP_DIR / "js/views/deliveryView.js").read_text(encoding="utf-8")
        catalog = (APP_DIR / "js/data/productCatalogSeed.js").read_text(encoding="utf-8")

        self.assertIn('label: "账号数据", zone: "overview"', main)
        self.assertIn('title: "数据看板", zone: "overview"', main)
        self.assertGreaterEqual(main.count('key: "account-data-dashboard"'), 2)
        self.assertIn('title: "所有账号"', main)
        self.assertIn('<span>账号数据</span>', home)
        self.assertIn('go("overview")', home)
        self.assertIn("deliveryFiltersByScope", delivery)
        self.assertIn("persistDeliveryFilters();", delivery)
        self.assertIn("创作 ${esc(dateTimeFromTime", delivery)
        self.assertIn('PRODUCT_CATALOG_VERSION = "20260817-product-db-v6-baige-token-plan-night"', catalog)
        self.assertIn("LoongForge 多模态训练提速 45%", catalog)
        self.assertIn("RealOmni-Open DataSet 超过 1 万小时", catalog)
        self.assertNotIn("不得将待确定的 LoongForge 写成已发布能力", catalog)


if __name__ == "__main__":
    unittest.main()
