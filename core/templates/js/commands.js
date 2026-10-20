function TryJoinGame() {
    let gameId = document.getElementById('game_id').value.trim().toUpperCase();
    if (!gameId) {
        blinkInputError('game_id');
        reportError(t('game_id_empty'));
        return;
    }

    startedNewGame = true;
    let gamePassword = document.getElementById('game_password').value;

    sendJoinRequest(gameId, gamePassword);
}

function TryJoinGameWithId(gameId, password) {
    startedNewGame = true;
    sendJoinRequest(gameId.toUpperCase(), password || '');
}

function sendJoinRequest(gameId, password) {
    let joinGameRequest = JSON.stringify({
        'Join': {
            'name': gameId,
            'password': (password || '').trim(),
            'player_type': 'Browser',
        }
    });

    socket.send(joinGameRequest);
}

function ResumeGame() {
    SendMessage({'ResumeGame': true});
}

const REACTION_MIN_INTERVAL_MS = 150;
var _lastReactionSentAt = 0;

function SendReaction(message) {
    var now = performance.now();
    if (now - _lastReactionSentAt < REACTION_MIN_INTERVAL_MS) return;
    _lastReactionSentAt = now;
    SendMessage(message);
}

function PlayClap() {
    SendReaction({'PlayClap': 'true'});

    var emoji = document.getElementById('applause_emoji');
    if (emoji) {
        emoji.classList.remove('clap-pulse');
        // Force reflow so the animation can replay on rapid taps
        void emoji.offsetWidth;
        emoji.classList.add('clap-pulse');
    }
}

function LeaveGame() {
    window.pqStore.removeItem('state');

    // send() still throws if the socket dies between the readyState check and the call; the reload
    // below is the actual exit, so it must not be skipped over a frame that no longer matters.
    try {
        if (socket && socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({'Leave': null}));
        else
            console.error('WebSocket not connected');
    } catch (e) {
        console.error('Leave frame not sent: ' + e);
    }

    // Reload so the fresh (stateless) page renders immediately. Small delay lets the Leave frame flush.
    setTimeout(() => location.reload(), 200);
}

function SetHostRole() {
    SendMessage({'SetRole': 'host'});
}

function SetPlayerRole() {
    SendMessage({'SetRole': 'player'});
}

window.lastSubmittedInfo = null;

// Matchmaker currently accepts only TEXT websocket frames; binary frames are rejected.
const CUSTOM_AVATAR_UPLOAD = {
    // Base64 chars per chunk. Must be divisible by 4 to keep base64 alignment.
    CHUNK_CHARS: 16000
};

function customAvatarMetaOnly(payload) {
    if (!payload) return undefined;
    return {
        Width: payload.Width,
        Height: payload.Height,
        Hash: payload.Hash,
        PayloadSize: payload.PayloadSize,
        TilingX: payload.TilingX,
        TilingY: payload.TilingY,
        OffsetX: payload.OffsetX,
        OffsetY: payload.OffsetY,
        Scale: payload.Scale,
        Rotation: payload.Rotation
    };
}

function splitBase64IntoChunks(b64, chunkChars) {
    if (!b64) return [];
    const size = Math.max(4, (chunkChars | 0));
    const aligned = size - (size % 4);
    const out = [];
    for (let i = 0; i < b64.length; i += aligned) {
        out.push(b64.slice(i, i + aligned));
    }
    return out;
}

async function uploadCustomAvatarIfNeeded(payload) {
    if (!payload || !payload.Data || !payload.Hash) return;
    if (!window.customAvatar) window.customAvatar = {};
    if (window.customAvatar._uploadedHash === payload.Hash) return;

    const chunks = splitBase64IntoChunks(payload.Data, CUSTOM_AVATAR_UPLOAD.CHUNK_CHARS);

    SendMessage({
        'RelayType': 1,
        'CustomAvatarUploadStart': {
            'Hash': payload.Hash,
            'Width': payload.Width,
            'Height': payload.Height,
            'PayloadSize': payload.PayloadSize,
            'TotalChunks': chunks.length,
            'TilingX': payload.TilingX,
            'TilingY': payload.TilingY,
            'OffsetX': payload.OffsetX,
            'OffsetY': payload.OffsetY,
            'Scale': payload.Scale,
            'Rotation': payload.Rotation
        }
    });

    for (let i = 0; i < chunks.length; i++) {
        SendMessage({
            'RelayType': 1,
            'CustomAvatarUploadChunk': {
                'Hash': payload.Hash,
                'Index': i,
                'Data': chunks[i]
            }
        });

        // Yield occasionally to keep UI responsive.
        if ((i & 15) === 15) await new Promise(r => setTimeout(r, 0));
    }

    SendMessage({
        'RelayType': 1,
        'CustomAvatarUploadEnd': {
            'Hash': payload.Hash
        }
    });

    window.customAvatar._uploadedHash = payload.Hash;
}

const SET_INFO_MIN_INTERVAL_MS = 1500;
let lastSetInfoSentAt = 0;

async function SetInfo() {
    const btn = document.getElementById('set_info_button');
    if (btn && btn.classList.contains('disabled')) return;

    // The host drops a different SetInfo within 1 s and reports it as a security violation.
    const wait = lastSetInfoSentAt + SET_INFO_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));

    const playerName = document.getElementById('player_name').value.trim();
    const selfIntro = document.getElementById('player_intro').value.trim();

    blinkInput('player_name');
    blinkInput('player_intro');

    if (document.getElementById('info_set_error')) document.getElementById('info_set_error').textContent = "";

    window.pqStore.setItem('name', playerName);

    const selected = avatars[currentAvatarIndex];

    const allowCustom = (window.allowCustomAvatars !== false);
    const isCustomSelected = allowCustom && (window.customAvatar && selected === window.customAvatar.id);
    const fullPayload = (window.customAvatar && window.customAvatar.payload && window.customAvatar.payload.Data)
        ? window.customAvatar.payload
        : undefined;

    // Always send meta-only in SetInfo to avoid huge JSON. If custom is selected, upload the image in chunks first.
    let customAvatarPayload = (allowCustom && fullPayload) ? customAvatarMetaOnly(fullPayload) : undefined;
    if (isCustomSelected && fullPayload) {
        try {
            await uploadCustomAvatarIfNeeded(fullPayload);
        } catch (e) {
            console.error(e);
            if (typeof window.reportError === 'function')
                window.reportError("Unable to upload custom avatar. Try again.");
            if (document.getElementById('info_set_error'))
                document.getElementById('info_set_error').textContent = "";
            updateSetInfoButtonState();
            return;
        }
    }

    // Save what we submitted (including custom avatar slider values)
    window.lastSubmittedInfo = {
        name: playerName,
        intro: selfIntro,
        avatar: avatars[currentAvatarIndex],
        customPayloadHash: customAvatarPayload ? customAvatarPayload.Hash : null,
        customOffsetX: customAvatarPayload ? customAvatarPayload.OffsetX : null,
        customOffsetY: customAvatarPayload ? customAvatarPayload.OffsetY : null,
        customScale: customAvatarPayload ? customAvatarPayload.Scale : null,
        customRotation: customAvatarPayload ? customAvatarPayload.Rotation : null
    };

    if (typeof persistCustomAvatarToStorage === 'function') {
        persistCustomAvatarToStorage();
    }

    // Disable button after submit
    updateSetInfoButtonState();

    lastSetInfoSentAt = Date.now();
    SendMessage({
        'SetInfo':
            {
                'Name': playerName,
                'SelfIntroduction': selfIntro,
                'Avatar': avatars[currentAvatarIndex],
                'CustomAvatar': customAvatarPayload
            }
    });
}

function hasInfoChanged() {
    const playerName = document.getElementById('player_name')?.value.trim() || '';
    const selfIntro = document.getElementById('player_intro')?.value.trim() || '';
    const currentAvatar = avatars[currentAvatarIndex] || '';
    const customPayload = (window.customAvatar && window.customAvatar.payload && window.customAvatar.payload.Data)
        ? window.customAvatar.payload : null;
    const currentHash = customPayload ? customPayload.Hash : null;

    if (!window.lastSubmittedInfo) {
        // Never submitted - enable if name is not empty
        return playerName.length > 0;
    }

    if (playerName !== window.lastSubmittedInfo.name ||
        selfIntro !== window.lastSubmittedInfo.intro ||
        currentAvatar !== window.lastSubmittedInfo.avatar ||
        currentHash !== window.lastSubmittedInfo.customPayloadHash) {
        return true;
    }

    if (customPayload) {
        if (customPayload.OffsetX !== window.lastSubmittedInfo.customOffsetX ||
            customPayload.OffsetY !== window.lastSubmittedInfo.customOffsetY ||
            customPayload.Scale !== window.lastSubmittedInfo.customScale ||
            customPayload.Rotation !== window.lastSubmittedInfo.customRotation) {
            return true;
        }
    }

    return false;
}

function updateSetInfoButtonState() {
    const btn = document.getElementById('set_info_button');
    if (!btn) return;

    if (hasInfoChanged()) {
        btn.classList.remove('disabled');
    } else {
        btn.classList.add('disabled');
    }
}

function showToast(message, duration) {
    const toast = document.getElementById('toast');
    if (!toast) return;

    if (message) toast.textContent = message;
    toast.classList.add('visible');

    setTimeout(() => {
        toast.classList.remove('visible');
    }, duration || 2500);
}

function CallAllHere() {
    SendMessage({
        'AllHere':
            {
                'Selector': '',
            }
    });
}

function PlayEmoji(emojiType) {
    SendReaction({'PlayEmoji': emojiType});
}

function CallNextRound() {
    SendMessage({'NextRound': 'true'});
}

const BUZZ_MIN_INTERVAL_MS = 100;
var _lastBuzzSentAt = 0;
var _lastBuzzArmedAt;

function AnswerButtonPressed() {
    // Local answer to the finger first: the button goes down and the phone ticks before the
    // message is anywhere near the relay.
    if (window.pqBuzzFeedback) window.pqBuzzFeedback();

    // Multi-finger mashing outruns the host rate limit; the first press after arming always goes.
    const now = performance.now();
    if (window.pqBuzzArmedAt === _lastBuzzArmedAt && now - _lastBuzzSentAt < BUZZ_MIN_INTERVAL_MS)
        return;
    _lastBuzzSentAt = now;
    _lastBuzzArmedAt = window.pqBuzzArmedAt;

    const message = {'ButtonPressed': 'answer'};

    // The host compares reaction times instead of packet arrival, so a slower connection does not lose
    // the buzzer. window.pqBuzzArmedAt is set when the button becomes live; a reading too old to describe
    // a reaction is dropped, and that press is judged by arrival instead of losing outright.
    if (window.pqBuzzArmedAt == null) {
        // Pressed before the question, or while somebody else answers. It still travels so everyone sees
        // the avatar press the button, but the host keeps it out of the answering window.
        message.EarlyPress = true;
    } else {
        const elapsed = Math.round(performance.now() - window.pqBuzzArmedAt);

        if (elapsed <= 30000)
            message.ReactionMs = elapsed;
    }

    SendMessage(message);
}

function SetAnswerDecisionButtonsEnabled(enabled) {
    const group = document.getElementById('player_answers_host_group');

    if (!group)
        return;

    group.querySelectorAll('button').forEach(b => b.disabled = !enabled);
}

function ReportAnswerDecision(isCorrect, scoreMultiplier = 1) {
    const group = document.getElementById('player_answers_host_group');

    if (group && group.querySelector('button:disabled'))
        return;

    SetAnswerDecisionButtonsEnabled(false);

    const sent = SendMessage({'AnswerDecision': {'IsCorrect': isCorrect, 'ScoreMultiplier': scoreMultiplier}});

    // The socket was down when we tried to send: the verdict never left the browser. Re-enable the
    // buttons so the host can retry once reconnected — otherwise the click is lost forever and the
    // question hangs waiting for a decision that will never arrive.
    if (!sent)
        SetAnswerDecisionButtonsEnabled(true);
}

function ReplayAudio() {
    SendMessage({'ReplayAudio': 'true'});
}

function RevealingCluesStopGuessing() {
    SendMessage({'RevealingCluesStopGuessing': 'true'});
}

function RevealingCluesEndQuestion() {
    SendMessage({'RevealingCluesEndQuestion': 'true'});
}

function RevealingCluesGuessMade(guess) {
    guess = (guess || '').trim();

    if (!guess) {
        blinkInputError('revealing_clues_input');
        return;
    }

    SendMessage({'RevealingCluesGuessMade': guess});
}

function RevealingCluesPlayerPass() {
    window._rcPassed = true;
    SendMessage({'RevealingCluesPassed': 'true'});
}

function ReportRevealingCluesDecision(decision) {
    SendMessage({'RevealingCluesGuessDecision': decision});
}

function StopFinalBidding() {
    SendMessage({'StopFinalBidding': 'true'});
}

function DismissQuestion() {
    SendMessage({'DismissQuestion': 'true'});
}

function StopFinalAnswering() {
    SendMessage({'StopFinalAnswering': 'true'});
}

function SelectCatInPokeOwner(playerId, isRandom) {
    SendMessage({
        'CatInPokeOwnerSelected':
            {
                'Id': playerId,
                'IsRandom': isRandom,
            }
    });
}

function KickPlayer(playerId) {
    var player = (window.pqStandings || []).concat(window.pqLobbyPlayers || []).find(p => p.Id === playerId);
    pqConfirm(t('kick_confirm').replace('{0}', player ? player.Name : ''), () => DoKickPlayer(playerId));
}

function pqConfirm(message, onOk) {
    var popup = document.getElementById('confirm_popup');
    var overlay = document.getElementById('error_popup_overlay');
    document.getElementById('confirm_popup_message').textContent = message;

    function close() {
        popup.classList.remove('visible');
        overlay.classList.remove('visible');
        popup.setAttribute('aria-hidden', 'true');
    }

    document.getElementById('confirm_popup_ok').onclick = () => { close(); onOk(); };
    document.getElementById('confirm_popup_cancel').onclick = close;

    popup.classList.remove('fade-out');
    overlay.classList.remove('fade-out');
    popup.classList.add('visible');
    overlay.classList.add('visible');
    popup.setAttribute('aria-hidden', 'false');
}

function DoKickPlayer(playerId) {
    SendMessage({'KickPlayer': playerId});
    window.pqStandings = (window.pqStandings || []).filter(p => p.Id !== playerId);
    if (typeof CreatePlayersForScoreChange === 'function') CreatePlayersForScoreChange(window.pqStandings);
    setTimeout(RequestPlayersList, 1000);
}

window.adjustScorePlayerId = null;

function OpenAdjustScore(playerId) {
    window.adjustScorePlayerId = playerId;
    document.getElementById('adjust_step').value = 10;
    document.getElementById('change-score-group').hidden = true;
    document.getElementById('adjust_score_group').hidden = false;
    RenderAdjustScore();
}

function CloseAdjustScore() {
    window.adjustScorePlayerId = null;
    document.getElementById('adjust_score_group').hidden = true;
    document.getElementById('change-score-group').hidden = false;
}

function RenderAdjustScore() {
    var player = (window.pqStandings || []).find(p => p.Id === window.adjustScorePlayerId);
    if (!player) { CloseAdjustScore(); return; }
    document.getElementById('adjust_score_name').textContent = player.Name || '';
    document.getElementById('adjust_score_value').textContent = t('score_x').replace('{0}', player.Score || 0);
}

function AdjustScore(sign) {
    var input = document.getElementById('adjust_step');
    var amount = parseInt(input.value, 10);
    var player = (window.pqStandings || []).find(p => p.Id === window.adjustScorePlayerId);
    if (!player || isNaN(amount) || amount <= 0) return;

    player.Score = (player.Score || 0) + sign * amount;
    SendMessage({'AdjustScore': {'PlayerId': player.Id, 'Score': player.Score}});
    RenderAdjustScore();

    input.classList.remove('blink-add', 'blink-sub');
    void input.offsetWidth;
    input.classList.add(sign > 0 ? 'blink-add' : 'blink-sub');
}

function RemoveFinalRoundTheme(theme) {
    SendMessage({'FinalRoundRemoveTheme': theme})
}

function MultipleChoiceVote(option) {
    SendMessage({'MultipleChoiceVote': option})
}

function EndMultipleChoice() {
    SendMessage({'EndMultipleChoice': true})
}

function NumberGuessMade(guess) {
    var number = String(guess == null ? '' : guess).trim().replace(',', '.');

    if (!/^(\d+\.?\d*|\.\d+)$/.test(number)) {
        blinkInputError('number_guess_input');
        return;
    }

    SendMessage({'NumberGuessMade': number})
}

function EndNumberGuess() {
    SendMessage({'EndNumberGuess': true})
}

function EveryoneParticipates() {
    if (SendMessage({'FinalEveryoneParticipates': true}))
        LeaveDecideFinalPlayers();
}

function EligibleParticipate() {
    if (SendMessage({'FinalEligibleParticipate': true}))
        LeaveDecideFinalPlayers();
}

function LeaveDecideFinalPlayers() {
    goTo(window.pqStore.getItem('role') == 'host' ? 'SEQUENCE_HOST' : 'SEQUENCE_PLAYER');
}

function HostIntroducedTheme(theme) {
    SendMessage({'HostIntroducedThemeByIndex': String(theme)})
}

function NotifyCuriosityTheme(theme) {
    SendMessage({'CuriosityTheme': theme})
}

function SelectQuestion(theme, question) {
    SendMessage({'SelectedQuestion': {'ThemeId': theme, 'QuestionId': question}});
}

function sendFastForwardDirect(payload) {
    if (serviceRestart || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({'Message': JSON.stringify(payload)}));
}

function FastForwardTap() {
    sendFastForwardDirect({'RelayType': 1, 'FastForward': 'tap'});
}

function FastForwardHold(isHeld) {
    sendFastForwardDirect({'RelayType': 1, 'FastForwardHold': isHeld ? '1' : '0'});
}

function FinalRoundBid(amount) {
    SendMessage({'FinalRoundBid': amount});
}

function FinalRoundAnswer(answer) {
    SendMessage({'FinalRoundAnswer': answer});
}

const ANSWER_PREVIEW_INTERVAL_MS = 500;
var _answerPreviewTimer = null;
var _answerPreviewLastSent = '';
var _answerPreviewLastAt = 0;

function flushAnswerPreview() {
    _answerPreviewTimer = null;
    var value = document.getElementById('player_answer_input').value;
    if (value === _answerPreviewLastSent) return;

    SendMessage({'PlayerAnswerPreview': value});
    _answerPreviewLastSent = value;
    _answerPreviewLastAt = performance.now();
}

function PlayerAnswerPreviewInput() {
    if (_answerCooldownActive) return;
    if (_answerPreviewTimer) return;

    var wait = Math.max(0, ANSWER_PREVIEW_INTERVAL_MS - (performance.now() - _answerPreviewLastAt));
    _answerPreviewTimer = setTimeout(flushAnswerPreview, wait);
}

function cancelAnswerPreview() {
    clearTimeout(_answerPreviewTimer);
    _answerPreviewTimer = null;
    _answerPreviewLastSent = '';
}

var _answerCooldownActive = false;
var _answerEpoch = null;
var _lastPlayerAnswer = '';

function restoreLastPlayerAnswer() {
    var input = document.getElementById('player_answer_input');
    if (input.value === '') input.value = _lastPlayerAnswer;
}

function PlayerAnswer(answer) {
    if (_answerCooldownActive) return;

    cancelAnswerPreview();

    blinkInput('player_answer_input');
    document.getElementById("player_answer_input").value = "";
    _lastPlayerAnswer = answer;
    var msg = {'PlayerAnswer': answer};
    if (typeof _answerEpoch === 'number') msg.PlayerAnswerEpoch = _answerEpoch;
    SendMessage(msg);

    _answerCooldownActive = true;
    var btn = document.getElementById('player_answer_input_button');
    var label = document.getElementById('answer_submitted_label');

    if (btn) btn.style.pointerEvents = 'none';

    if (label) {
        label.classList.remove('fading');
        void label.offsetWidth;
        label.classList.add('visible');

        setTimeout(function() {
            label.classList.remove('visible');
            label.classList.add('fading');
            setTimeout(function() {
                label.classList.remove('fading');
                if (btn) btn.style.pointerEvents = '';
                _answerCooldownActive = false;
            }, 400);
        }, 600);
    } else {
        setTimeout(function() {
            if (btn) btn.style.pointerEvents = '';
            _answerCooldownActive = false;
        }, 1000);
    }
}

function MakeBid(bid, oldValue) {
    SendMessage({'MakeBid': {'Bid': bid, 'OldValue': oldValue}});
}

function AuctionPass() {
    SendMessage({'AuctionPass': true});
}

function EndAuction() {
    SendMessage({'EndAuction': true});
}

function ReportFinalAnswerDecision(isCorrect) {
    SendMessage({'FinalRoundAnswerDecision': {'IsCorrect': isCorrect}});
}

function ReportCuriosityOrEndGame(curious) {
    SendMessage({'ReportCuriosityOrEndGame': curious});
}

function CuriosityRevealAnswer() {
    SendMessage({'CuriosityRevealAnswer': true});
}

function ChangeCamera(mode) {
    SendMessage({'ChangeCameraIndex': mode});
}

function ToggleChangeScoreListPopup() {
    var popupMenu = document.getElementById("change-score-list-popup");
    if (popupMenu.style.display != "block") {
        OpenChangeScoreListPopup();
    } else {
        CloseChangeScoreListPopup();
    }
}

function InheritRequest(targetId) { window.pqInheritChosen = targetId; SendMessage({'InheritRequest': targetId}); goTo('INHERIT_WAIT'); }
function InheritDecline() { SendMessage({'InheritDecline': 'true'}); returnToSetInfo(null); }
function InheritCancel() { SendMessage({'InheritCancel': 'true'}); returnToSetInfo(null); }
function InheritApprove(requestId) { SendMessage({'InheritApprove': requestId}); RemoveInheritRequest(requestId); }
function InheritReject(requestId) { SendMessage({'InheritReject': requestId}); RemoveInheritRequest(requestId); }

function OpenChangeScoreListPopup() {
    var popupMenu = document.getElementById("change-score-list-popup");
    var overlay = document.getElementById("popup-overlay");
    document.body.classList.add("no-scroll");
    popupMenu.style.display = "block";
    overlay.style.display = "block";

    RequestPlayersList();
}

function CloseChangeScoreListPopup() {
    CloseAdjustScore();
    var popupMenu = document.getElementById("change-score-list-popup");
    var overlay = document.getElementById("popup-overlay");
    document.body.classList.remove("no-scroll");
    popupMenu.style.display = "none";
    overlay.style.display = "none";
}


function RequestPlayersList() {
    SendMessage({'RequestPlayersList': true});
}

function RefreshData() {
    SendMessage({'RefreshData': 'true'});
}

// Wire envelope matches the host DTOs (PartyQuiz.Network.CreateTeam/JoinTeam/LeaveTeam/SubmitSuggestion):
// presence of the field selects the handler; Platform is a case-sensitive "Browser".

function CreateTeam(teamName, avatar, customAvatar) {
    SendMessage({
        'CreateTeam': {
            'Name': teamName,
            'Avatar': avatar,
            'Platform': 'Browser',
            'MemberName': (window.myMemberName || teamName),
            'CustomAvatar': customAvatar || undefined
        }
    });
}

function JoinTeam(teamId, memberName) {
    SendMessage({
        'JoinTeam': {
            'TeamId': teamId,
            'Platform': 'Browser',
            'MemberName': memberName || window.myMemberName || ''
        }
    });
}

function LeaveTeam() {
    SendMessage({ 'LeaveTeam': {} });
}

function SubmitSuggestion(value) {
    SendMessage({ 'SubmitSuggestion': { 'Value': value } });
}

function AppealRequest(epoch) {
    SendMessage({'AppealRequest': String(epoch)})
}

function AppealVote(appealId, isRight) {
    SendMessage({'AppealVote': appealId + ':' + (isRight ? '1' : '0')})
}

function BonusStopRequest(seq) {
    SendMessage({'BonusStopRequest': String(seq)})
}

function BonusDiscardChoice(seq, index) {
    SendMessage({'BonusDiscardChoice': seq + ':' + index})
}

function BonusActivate() {
    SendMessage({'BonusActivate': '1'})
}

function BonusChoose(activationId, slot) {
    SendMessage({'BonusChoose': activationId + ':' + slot})
}

function BonusVictimPick(activationId, themeId, questionId, victimId) {
    SendMessage({'BonusVictimPick': activationId + ':' + themeId + ':' + questionId + ':' + victimId})
}
