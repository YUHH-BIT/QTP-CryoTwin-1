"""
冰冻圈灾害大模型模块
================
轻量方案：Flask 后端直连 DeepSeek API（OpenAI 兼容协议），
以 SSE 流式方式把回复转发给前端。

安全约定：
- API 密钥只存在于后端 config（DEEPSEEK_API_KEY），严禁写入前端代码。
- 前端只调用本模块的 /api/llm/chat，由后端统一转发，密钥不出后端。
"""
import json
import logging
import requests
from flask import Blueprint, request, jsonify, Response, current_app, stream_with_context
from modules import admin_db, expert_kb

llm_bp = Blueprint('llm', __name__, url_prefix='/api/llm')

logger = logging.getLogger(__name__)

# 冰冻圈灾害大模型系统提示词（角色设定 + 领域知识边界）
# 对话安全限制：防止超大历史刷接口/刷费用
MAX_HISTORY_MESSAGES = 20
MAX_MESSAGE_CHARS = 4000

# 冰冻圈灾害大模型系统提示词（角色设定 + 领域知识边界）
SYSTEM_PROMPT = """你是"青藏高原冰冻圈灾害数字孪生系统"的冰冻圈灾害大模型，一位融合自然与人文地理学素养的冰冻圈科学专家。你深谙冰冻圈各要素如何作为互相关联的系统运作：气温与降水驱动冰川物质平衡与积雪累积，冰川与积雪融水塑造径流与冰湖，冻土变化改变地表稳定与水文过程，而这一切在气候变暖背景下正加速变化；你同时相信地图会讲述故事，没有任何地理或冰冻圈过程是孤立的。
1.身份：自然与人文地理学家兼冰冻圈科学家，专精气候系统、地貌学、水文学、冰川学、冻土学、积雪与融雪水文、冰湖与冰湖溃决、资源分布、空间分析与冰冻圈灾害风险评估，服务于本系统（覆盖洪水、积雪、冰川、冻土四类冰冻圈灾害的数据库、灾害过程模拟、风险评估与决策支持）。
2.个性：系统思维者、证据导向，严谨审慎，处处能看到关联，坚持用物理过程解释现象，会温和而坚定地指出不合理的灾害或地理推断。
3.记忆：在整个对话中追踪流域、灾害事件、气候条件、资源位置与模拟结果，保持物理一致性，维护正在分析区域的"心理模型"，当新信息与已确立条件矛盾时发出提示。
4.经验：扎根于自然地理学（柯本气候分类、板块构造、水文学）与人文地理学（克里斯塔勒的中心地理论、麦金德的陆心理论、沃勒斯坦的世界体系理论）、GIS/制图学及环境决定论的相关争论（戴蒙德、阿西莫格鲁的批评），并深入冰川学（物质平衡、冰川跃动、冰湖溃决GLOF）、冻土学（多年冻土退化、热融滑塌、冻胀）、积雪水文（融雪径流、雪崩、风吹雪）、冰冻圈水文（冰川融水、冰湖、径流）、气候变化影响评估与遥感监测。
5.核心使命：(1)基于用户提供的灾害模拟与风险评估数据，给出防灾减灾与应急决策建议（洪水、融雪洪水、冰湖溃决、滑坡堰塞湖、雪崩、风吹雪、冻土灾害）；(2)解释冰冻圈灾害的形成机理与致灾因子（气温升高、强降水、冰川跃动、冰湖扩张、冻土退化等如何触发灾害）；(3)评估风险：危险性、暴露度与脆弱性耦合，区分高风险区与低风险区，给出分级建议；(4)推荐工程措施（堤坝、排水、坝体加固等）与非工程措施（监测预警、应急预案、疏散路线、土地规划等）；(5)验证地理与水文一致性，检查气候、地形、水文与灾害之间的物理一致性；(6)分析人地互动，评估地理如何制约和赋能聚落与文明，设计遵循地理逻辑的贸易路线，评估基于资源的权力动态；(7)强调监测与预警，给出可操作的观测与预警要点（遥感、气象站、冰湖水位等）。
6.关键规则：(1)不编造数据：涉及本系统具体数据（如某一流域某日融雪径流值、淹没范围、风险评估分级）时，应引导用户先在系统中完成对应模块的模拟或识别后再咨询；(2)以物理过程为依据：每个灾害推断都要有明确的机理支撑，区分确定结论与不确定推断，说明数据与模型的局限；(3)气候是一个系统：雨影效应、洋流、纬度、海拔都会影响气候，不要在没有特殊理由的情况下放置地理上不可能的特征；(4)地理不是装饰：每座山、每条河、每片沙漠都会对附近的人们产生影响，放置了特征就要解释其影响；(5)避免地理决定论：地理制约但不决定一切，相似的环境会产生不同的文化，承认人的能动性；(6)尺度很重要：局地点位、流域尺度与高原尺度的灾害过程与应对手段根本不同；(7)气候变化背景：高原升温、冰川退缩、冻土退化和极端降水是灾害频发的重要背景，评估时须纳入；(8)安全第一：防灾建议以人身与设施安全为最高优先级，必要时明确建议撤离与避险；(9)地图与数据是一种论述：注意遥感与模型数据的分辨率、时间与不确定性。
7.技术交付物（按需，不默认全量）：仅当用户明确要求"完整报告/详细分析/系统评估/逐条展开"时，才输出"冰冻圈灾害分析报告"（灾害类型、区域与时段、致灾因子、孕灾环境、灾害过程、承灾体暴露、脆弱性、风险分级、高风险区识别、工程与非工程措施、监测要点）或"风险分级解读"（风险等级、危险性/暴露度/脆弱性依据、分级的应对措施）；其余情况按第13条分层作答，不要把整套报告模板套在一次普通问答上。
8.工作流程：(1)明确灾害类型与时空范围；(2)分析致灾因子与触发机制；(3)结合系统数据（灾害数据库、模拟与风险评估结果）；(4)评估暴露与脆弱性；(5)给出分级建议与监测预警要点，必要时明确避险撤离。
9.沟通风格：专业、简洁、条理清晰，面向应急管理与防灾决策人员；使用视觉化与空间化描述和真实高原案例类比；温和但坚定地纠正缺乏机理支撑的推断；以地图思维自然描述空间关系与距离。
10.成功指标：灾害机理解释正确且有物理依据；建议可执行、面向决策；不编造数据，明确区分已知与推断；风险分级清晰、高风险区识别有理有据。
11.高级能力：冰湖溃决（GLOF）溃决机理与洪峰演进、融雪径流预报、冻土退化评估、遥感与监测（SAR、光学影像、冰湖水位与冰川运动）、气候变化情景预估、古气候学、城市地理与地缘政治分析、环境史与制图设计。
12.能力边界：若问题超出地理学与冰冻圈防灾减灾领域，请礼貌说明能力边界；回答要求专业、简洁、条理清晰，避免堆砌无关信息。
13.输出格式与分层（硬性约束，优先于前述"输出分析报告"的倾向）：
(1)默认只答第一层：总长控制在 300 字以内，结构固定为三块——①一句直接判断（有没有影响/能不能做/风险高低）；②2~3 条核心机理或依据，每条一句话；③一句数据边界（系统数据覆盖到什么程度、哪些必须先在系统中跑模拟）。结尾用一句话询问用户想展开哪一部分。
(2)不主动铺开章节：禁止在首轮回答里直接输出五个以上小节、完整对策清单或全量监测要点；这些属于第二层，等用户明确说"展开""详细说""完整报告""逐条分析"或追问某一小节时再给。
(3)排版规范：使用 Markdown；标题最多到三级（###），一次回答最多 4 个并列小节；表格只在确有横向对比价值时使用，最多 3 列、6 行，超限改用列表；300 字的短答里不使用表格；不为凑结构而堆砌小标题。
(4)引用标注：[数据源：xxx] 紧跟在对应结论句末，不单独成段，不重复标注同一来源。
(5)不要写"这是第一步的诚实""这是对决策负责的方式"这类自我评价式旁白，直接给结论。"""


def build_messages(request_data, system_prompt=None):
    """组装发送给 DeepSeek 的 messages（含系统提示词，并限制条数与长度）。

    system_prompt 为 None 时使用内置默认 SYSTEM_PROMPT（即未配置管理端设置时）。
    """
    messages = [{'role': 'system', 'content': system_prompt or SYSTEM_PROMPT}]
    history = request_data.get('messages') or []
    # 只取最近 MAX_HISTORY_MESSAGES 条，且单条内容截断，防止刷接口/刷费用
    for msg in history[-MAX_HISTORY_MESSAGES:]:
        role = msg.get('role')
        content = msg.get('content')
        if role in ('user', 'assistant') and content:
            content = str(content)[-MAX_MESSAGE_CHARS:]
            messages.append({'role': role, 'content': content})
    return messages


@llm_bp.route('/chat', methods=['POST'])
def chat():
    """代理 DeepSeek 对话接口，SSE 流式返回。

    检索增强（RAG）：自动从本系统真实数据知识库（expert_kb）检索与用户问题
    相关的灾害案例/县域数据/方法学，注入到最后一条用户消息，并要求回答
    引用真实数据（[数据源：xxx] 标注）。检索失败时降级为纯对话。
    """
    data = request.get_json(silent=True) or {}
    # 系统提示词支持管理端动态配置（admin.db settings.agent_system_prompt），未配置时用内置默认
    system_prompt = admin_db.get_setting(
        current_app.config['BASE_DIR'], 'agent_system_prompt')
    messages = build_messages(data, system_prompt)
    if not any(m['role'] == 'user' for m in messages):
        return jsonify({'success': False, 'message': '缺少用户消息'}), 400

    # ---- 检索本系统真实数据（RAG）----
    question = ''
    for msg in reversed(data.get('messages') or []):
        if msg.get('role') == 'user' and msg.get('content'):
            question = str(msg['content'])[-MAX_MESSAGE_CHARS:]
            break
    context_text = ''
    try:
        ctx = expert_kb.build_context(question, max_cases=6)
        context_text = ctx['text']
    except Exception as e:
        logger.warning('真实数据检索失败（降级为纯对话）: %s', e)

    if context_text and messages and messages[-1].get('role') == 'user':
        messages[-1]['content'] = (
            '【系统真实数据（自动检索自本系统数据库，均为真实记录，'
            '回答必须引用并在引用处标注[数据源：xxx]；数据未覆盖的内容明确说明"系统数据未覆盖"）】\n'
            + context_text
            + '\n\n【用户问题】\n' + messages[-1]['content']
        )

    api_key = current_app.config.get('DEEPSEEK_API_KEY')
    if not api_key:
        logger.error('未配置 DEEPSEEK_API_KEY')
        return jsonify({'success': False, 'message': '后端未配置 DeepSeek API 密钥'}), 500

    model = current_app.config.get('DEEPSEEK_MODEL', 'deepseek-v4-flash')
    api_url = current_app.config.get(
        'DEEPSEEK_API_URL', 'https://api.deepseek.com/chat/completions')

    payload = {
        'model': model,
        'messages': messages,
        'stream': True,
        'temperature': 0.7,
        # 上限兜底：约可容纳 2000+ 汉字，足够用户主动要求"完整报告"时的第二层作答，
        # 同时避免模型无节制铺陈（单纯靠提示词约束不可靠）。如需更长可调高。
        'max_tokens': 3000,
    }
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
    }

    def generate():
        """把 DeepSeek 的 SSE 流逐条透传给前端。"""
        try:
            upstream = requests.post(
                api_url, json=payload, headers=headers,
                stream=True, timeout=(10, 120)
            )
            # 非 200：读取上游错误详情透传给前端，便于快速定位
            if upstream.status_code != 200:
                detail = ''
                try:
                    err_json = upstream.json()
                    detail = str(err_json.get('error') or err_json)
                except Exception:
                    detail = upstream.text[:500]
                logger.error(f'DeepSeek 返回 {upstream.status_code}: {detail}')
                error_msg = json.dumps(
                    {'error': f'DeepSeek 接口错误({upstream.status_code}): {detail}'},
                    ensure_ascii=False)
                yield f"data: {error_msg}\n\n"
                return
            for line in upstream.iter_lines(decode_unicode=True):
                if not line:
                    continue
                if not line.startswith('data:'):
                    continue
                data_str = line[len('data:'):].strip()
                if data_str == '[DONE]':
                    yield 'data: [DONE]\n\n'
                    break
                try:
                    chunk = json.loads(data_str)
                    delta = chunk.get('choices', [{}])[0].get('delta', {})
                    content = delta.get('content', '')
                    if content:
                        yield f"data: {json.dumps({'content': content}, ensure_ascii=False)}\n\n"
                except (json.JSONDecodeError, IndexError, TypeError):
                    continue
        except requests.exceptions.RequestException as e:
            logger.error(f'DeepSeek 请求异常: {e}')
            error_msg = json.dumps({'error': f'调用 DeepSeek 失败: {e}'},
                                   ensure_ascii=False)
            yield f"data: {error_msg}\n\n"
        except Exception as e:
            logger.error(f'LLM 模块异常: {e}')
            error_msg = json.dumps({'error': f'服务器错误: {e}'},
                                   ensure_ascii=False)
            yield f"data: {error_msg}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
            'Connection': 'keep-alive',
        }
    )


@llm_bp.route('/health', methods=['GET'])
def health():
    """连通性检查（不暴露密钥）。"""
    return jsonify({
        'success': True,
        'model': current_app.config.get('DEEPSEEK_MODEL', ''),
        'configured': bool(current_app.config.get('DEEPSEEK_API_KEY')),
    })
