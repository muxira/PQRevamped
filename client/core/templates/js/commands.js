function TryJoinGame() {
    startedNewGame = true;

    let gameId = document.getElementById('game_id').value.toUpperCase();
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
            'password': password,
            'player_type': 'Browser',
        }
    });

    socket.send(joinGameRequest);
}

function ResumeGame() {
    SendMessage({'ResumeGame': true});
}

function PlayClap() {
    SendMessage({'PlayClap': 'true'});

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
    try { socket.send(JSON.stringify({'Leave': null})); } catch (e) { /* ignore if socket closed */ }
    // Reload so the fresh (stateless) page renders immediately. Small delay lets the Leave frame flush.
    setTimeout(() => location.reload(), 200);
}

function RequestLeaveGame() {
    var overlay = document.getElementById('leave_confirm_overlay');
    var modal = document.getElementById('leave_confirm_modal');
    if (!overlay || !modal) { LeaveGame(); return; }
    overlay.hidden = false;
    modal.hidden = false;
    if (window.i18n && typeof window.i18n.apply === 'function') {
        try { window.i18n.apply(modal); } catch (e) { /* ignore */ }
    }
}
function CancelLeaveGame() {
    var overlay = document.getElementById('leave_confirm_overlay');
    var modal = document.getElementById('leave_confirm_modal');
    if (overlay) overlay.hidden = true;
    if (modal) modal.hidden = true;
}
function ConfirmLeaveGame() {
    CancelLeaveGame();
    LeaveGame();
}

// ESC closes leave confirmation
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        var modal = document.getElementById('leave_confirm_modal');
        if (modal && !modal.hidden) {
            e.preventDefault();
            CancelLeaveGame();
        }
    }
});

function SetHostRole() {
    SendMessage({'SetRole': 'host'});
}

function SetPlayerRole() {
    SendMessage({'SetRole': 'player'});
}

// Track last submitted info to detect changes
window.lastSubmittedInfo = null;

// --- Custom avatar upload (chunked, text frames) ---
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

async function SetInfo() {
    const btn = document.getElementById('set_info_button');
    if (btn && btn.classList.contains('disabled')) return;

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

// Check if current info differs from last submitted
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

    // Check basic fields
    if (playerName !== window.lastSubmittedInfo.name ||
        selfIntro !== window.lastSubmittedInfo.intro ||
        currentAvatar !== window.lastSubmittedInfo.avatar ||
        currentHash !== window.lastSubmittedInfo.customPayloadHash) {
        return true;
    }

    // Check custom avatar slider values (if custom avatar is selected)
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
    SendMessage({'PlayEmoji': emojiType});
}

function CallNextRound() {
    SendMessage({'NextRound': 'true'});
}

function AnswerButtonPressed() {
    SendMessage({'ButtonPressed': 'answer'});
}

function ReportAnswerDecision(isCorrect, scoreMultiplier = 1) {
    SendMessage({'AnswerDecision': {'IsCorrect': isCorrect, 'ScoreMultiplier': scoreMultiplier}});
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
    SendMessage({'KickPlayer': playerId})
}

function SelectChangeScorePlayer(playerId) {
    console.log(playerId);
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
    var digits = String(guess == null ? '' : guess).trim();

    if (!digits || !/^\d+$/.test(digits)) {
        blinkInputError('number_guess_input');
        return;
    }

    SendMessage({'NumberGuessMade': digits})
}

function EndNumberGuess() {
    SendMessage({'EndNumberGuess': true})
}

function EveryoneParticipates() {
    SendMessage({'FinalEveryoneParticipates': true})
}

function EligibleParticipate() {
    SendMessage({'FinalEligibleParticipate': true})
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

function FastForward() {
    SendMessage({'FastForward': 'true'});
}

function SkipDisplaying() {
    SendMessage({'SkipDisplaying': 'true'});
}

function FinalRoundBid(amount) {
    SendMessage({'FinalRoundBid': amount});
}

function FinalRoundAllIn() {
    var input = document.getElementById('final_bid_input');
    var amount = (window.finalBidMax != null) ? window.finalBidMax : (input ? (input.max || input.value) : null);
    if (amount == null || String(amount).trim() === '') return;
    var str = String(amount);
    if (input) input.value = str;
    FinalRoundBid(str);
}

function FinalRoundAnswer(answer) {
    SendMessage({'FinalRoundAnswer': answer});
}

var _answerCooldownActive = false;

function PlayerAnswer(answer) {
    if (_answerCooldownActive) return;

    blinkInput('player_answer_input');
    document.getElementById("player_answer_input").value = "";
    SendMessage({'PlayerAnswer': answer});

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

function OpenChangeScoreListPopup() {
    var popupMenu = document.getElementById("change-score-list-popup");
    var overlay = document.getElementById("popup-overlay");
    document.body.classList.add("no-scroll");
    popupMenu.style.display = "block";
    overlay.style.display = "block";

    RequestPlayersList();
}

function CloseChangeScoreListPopup() {
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

// ---------- Team mode ----------
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