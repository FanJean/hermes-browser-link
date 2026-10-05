// 中文注释：站点禁止声明与提示注入分开判定；两者均过滤，只有前者设置站点自动化限制。
export const SITE_AUTOMATION_RESTRICTIONS = [
  /(?:禁止|不允许|不得|请勿|严禁).{0,20}(?:自动化操作|自动化访问|自动化工具|自动抓取|爬虫|机器人访问)/iu,
  /(?:自动化操作|自动化访问|自动抓取|爬虫|机器人访问).{0,20}(?:被禁止|不被允许|不可使用)/iu,
  /\b(?:automated?\s+(?:access|browsing|operations?|tools?|scraping)|automation|bots?|scrapers?)\b.{0,50}\b(?:prohibited|forbidden|not\s+(?:allowed|permitted)|disallowed)\b/iu,
  /\b(?:no|prohibit(?:ed)?|forbid(?:den)?|do\s+not\s+use)\b.{0,30}\b(?:automation|automated\s+(?:access|tools?|browsing|scraping)|bots?|scrapers?)\b/iu,
];
export const DIRECTIVES = [
  ...SITE_AUTOMATION_RESTRICTIONS,
  /(?:agent|AI\s*(?:助手|代理)|智能体).{0,25}(?:停止执行|停止工作|终止任务|不要继续|忽略用户)/iu,
  /(?:忽略|无视).{0,12}(?:之前|此前|用户|系统).{0,8}(?:指令|提示|要求)/u,
  /\b(?:AI\s+(?:agents?|assistants?)|agents?|assistants?)\b.{0,40}\b(?:stop|halt|abort|cease)\b.{0,25}\b(?:executing|working|task|execution|browsing|processing)\b/iu,
  /\b(?:ignore|disregard)\b.{0,25}\b(?:previous|prior|user|system)\b.{0,25}\b(?:instructions?|prompts?|requests?)\b/iu,
];
// 中文注释：实际阻塞信息优先保留，即便同一句也包含禁止自动化的文字。
export const BLOCKER = /captcha|验证码|人机验证|verify\s+you\s+are\s+human|verify\s+that\s+you\s+are\s+human|access\s+denied|permission\s+denied|unauthorized|rate\s+limit|too\s+many\s+requests|拒绝访问|权限不足|访问被拒|限流|请求过于频繁|登录|log\s*in|sign\s*in|\b(?:401|403|429)\b/iu;
const TEXT_FIELDS = new Set(['text', 'name', 'title', 'label', 'description', 'placeholder', 'alt', 'groupLabel', 'cells', 'raw']);
const PROTECTED_FIELDS = new Set(['binding', 'ref', 'sourceRef', 'parentRef', 'targetPath', 'fragment', 'snapshotId', 'parseId', 'nextCursor', 'url', 'href', 'src', 'id', 'status', 'code', 'error', 'exception', 'validationMessage', 'warnings', 'coverage']);
export const FILTER_ACTIONS = new Set(['snapshot', 'semantic_snapshot', 'page.observe', 'page.parse', 'js.evaluate']);

export function filterPageResult(action, result) {
  if (!FILTER_ACTIONS.has(action) || !result || result.ok === false) return result;
  let removed = 0,restricted=false;
  const filterText = value => {
    // 中文注释：完整 URL 与二进制数据不作为自然语言处理；逐句替换以保留相邻正文。
    if (/^(?:https?:|data:|blob:)/iu.test(value)) return value;
    return value.split(/([。！？.!?;；\n]+)/u).map(part => {
      const directive=DIRECTIVES.some(rule => rule.test(part));
      restricted ||= SITE_AUTOMATION_RESTRICTIONS.some(rule => rule.test(part));
      if (BLOCKER.test(part) || !directive) return part;
      removed++;
      return '[已过滤网页干扰文字]';
    }).join('');
  };
  const visit = (value, prose = false) => {
    if (typeof value === 'string') return prose ? filterText(value) : value;
    if (Array.isArray(value)) return value.map(item => visit(item, prose));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
      PROTECTED_FIELDS.has(key) ? child : visit(child, prose || TEXT_FIELDS.has(key) || key === 'fields'),
    ]));
  };
  // 中文注释：脚本只过滤成功返回的值；类型、异常和执行状态不改写。
  const filtered = action === 'js.evaluate' ? {...result, ...(Object.hasOwn(result, 'value') ? {value: visit(result.value, true)} : {})} : visit(result);
  return {...filtered, contentFilter: {enabled: true, removedSegments: removed+(result.contentFilter?.removedSegments||0), siteAutomationRestricted: restricted||result.contentFilter?.siteAutomationRestricted===true}};
}
