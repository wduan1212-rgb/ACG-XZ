/* 信息流台词标记：只识别真实说出口的内容，不把界面文字、导演说明或声音要求当字幕。 */

const ACTOR_TERM = "(?:角色(?:[A-Za-z0-9一二三四五六七八九十甲乙丙丁]{0,4})?|人物|主角|男主|女主|演员|博主|主播|室友|领导|老板|同事|朋友|客户|用户|职员|员工|店员|顾客|对方|产品经理|项目经理|经理|主管|主持人|记者|医生|老师|学生|工程师|设计师|运营|前台|男声|女声|人声|男生|女生|男人|女人|男子|女子|他|她|两人|三人|众人)";
const SPOKEN_VERB = "(?:说(?:出|道)?(?!话|明|法|辞|书)|喊|问(?!题|卷|号)(?:道)?|答道|回(?:道)?|回答(?:道)?|回应|反驳|质问|追问|强调|解释|提出(?:方案|观点|问题)?|吐槽(?:道)?|嘀咕|念(?:出)?|感叹(?:道)?|补充(?:道)?|提醒(?:道)?|反问(?:道)?|开口(?:说)?|脱口而出|收束|点出|自言自语|呼出一口气|(?:声音|话音)?从(?:画外|门外|身后)?传来|抛(?:出|下)?一句|(?:来)?一句)";
const SPOKEN_MANNER = "(?:厉声|压低声音|低声|轻声|咬牙|沉声|小声|高声|朗声|冷声|笑着|哭着|脱口而出|声音(?:急促|压低|低沉|沙哑|近胸腔|发紧|颤抖|轻快|冷静|坚定))";
// A source label may be followed by a short descriptor only when it ends in
// a colon (for example “口播自然扣回重点：”). Without a colon it must end
// immediately, so UI fields such as “口播要点 / 口播场控栏” are never speech.
const SPOKEN_SOURCE_RE = /(?:口播|旁白|旁|画外音|对白|台词)(?:原话|原文)?(?:[^。；;\n]{0,28}[:：]\s*|\s*)$/;
const SPOKEN_SOURCE_METADATA_GUARD_RE = /(?:口播|旁白|画外音|对白|台词)(?:要点|场控(?:栏)?|风格|规范|要求|说明|策略|节奏|语气|声线|设计|结构|规则)\s*[:：]\s*$/;
const SPOKEN_ACTOR_RE = new RegExp(`${ACTOR_TERM}[^。；;\\n]{0,42}(?:对镜头)?${SPOKEN_VERB}\\s*[:：]?\\s*$`);
const SPOKEN_ACTOR_LABEL_RE = new RegExp(`${ACTOR_TERM}[^。；;\\n]{0,24}\\s*[:：]\\s*$`);
const SPOKEN_ACTOR_DIRECT_RE = new RegExp(`${ACTOR_TERM}[^。；;\\n]{0,96}[，,]\\s*$`);
const SPOKEN_MANNER_RE = new RegExp(`${SPOKEN_MANNER}\\s*[:：]?\\s*$`);
const SPOKEN_SOURCE_ACTION_RE = /(?:口播|旁白|画外音|对白|台词)(?:自然)?收束\s*[:：]?\s*$/;
const SPOKEN_HUMAN_ACTION_RE = /(?:站起(?:来)?|抬头)\s*[:：]\s*$/;
const DIRECTOR_GUARD_RE = /(?:禁止|不要|不得|避免|无需|要求|提示(?!牌)|导演|负面约束)[^。；;\n]{0,72}$/;
const UI_GUARD_RE = /(?:界面|屏幕|显示器|输入框|按钮|标题|标签|文字|卡片|面板|工作台|状态)[^。；;\n]{0,140}(?:显示|出现|写着|输入|弹出)\s*[:：]?\s*$/;
const VISUAL_QUOTE_GUARD_RE = /(?:^|[，,])\s*(?:画面|镜头|场景|转场|构图|光线|字幕|花字)\s*(?:最终|缓慢|自然)?\s*(?:显示|出现|写着|输入|弹出|收束|定格|呈现)\s*[:：]\s*$/;
const ACTOR_ATTRIBUTE_GUARD_RE = /(?:表情|动作|姿势|服装|服饰|外貌(?:锚点)?|外观|形象|性格|一致性|角色锚点|镜头设计|说话风格|语言风格|声线|语气|声音要求|表演要求|状态|神态|站位|走位|造型|年龄|身份(?:设定)?|角色设定|人物设定|设定)\s*[:：]\s*$/;
const ACTOR_UI_ACTION_GUARD_RE = new RegExp(
  `${ACTOR_TERM}[^。；;\\n]{0,24}(?:输入|点击|选择|拖拽|上传|下载|打开|关闭|填写|勾选|切换|复制|粘贴|提交|保存|确认|操作|页面|界面|按钮|输入框|菜单|卡片|标签|标题)[^。；;\\n]{0,16}[:：]\\s*$`,
);
const ACTOR_DIRECT_UI_GUARD_RE = new RegExp(
  `${ACTOR_TERM}[^。；;\\n]{0,48}(?:写着|显示|标注|输入|点击|选择|拖拽|上传|下载|打开|关闭|填写|勾选|切换|复制|粘贴|提交|保存|确认)[^。；;\\n]{0,18}[，,]\\s*$`,
);

function recentClause(text = "", index = 0) {
  const before = String(text || "").slice(Math.max(0, Number(index || 0) - 180), Number(index || 0));
  const boundary = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("。"), before.lastIndexOf("；"), before.lastIndexOf(";"));
  return before.slice(boundary + 1).trim();
}

export function isInfoFlowSpokenQuoteContext(text = "", quoteIndex = 0) {
  const prefix = recentClause(text, quoteIndex);
  if (
    !prefix
    || DIRECTOR_GUARD_RE.test(prefix)
    || SPOKEN_SOURCE_METADATA_GUARD_RE.test(prefix)
    || UI_GUARD_RE.test(prefix)
    || VISUAL_QUOTE_GUARD_RE.test(prefix)
    || ACTOR_ATTRIBUTE_GUARD_RE.test(prefix)
  ) return false;
  if (
    SPOKEN_SOURCE_RE.test(prefix)
    || SPOKEN_SOURCE_ACTION_RE.test(prefix)
    || SPOKEN_ACTOR_RE.test(prefix)
    || SPOKEN_MANNER_RE.test(prefix)
    || SPOKEN_HUMAN_ACTION_RE.test(prefix)
  ) return true;
  if (SPOKEN_ACTOR_DIRECT_RE.test(prefix) && !ACTOR_DIRECT_UI_GUARD_RE.test(prefix)) return true;
  return SPOKEN_ACTOR_LABEL_RE.test(prefix) && !ACTOR_UI_ACTION_GUARD_RE.test(prefix);
}
