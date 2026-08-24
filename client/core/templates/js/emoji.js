const first_emoji_id = '#controls';
const second_emoji_id = '#cool';
const third_emoji_id = '#bigsmile';
const fourth_emoji_id = '#sad';
const fifth_emoji_id = '#sleep';
const sixth_emoji_id = '#sick';
const seventh_emoji_id = '#poop';

const button_main_id = '#button_main';
const buttons_id = '#buttons';

const firstEmoji = document.querySelector(first_emoji_id);
const secondEmoji = document.querySelector(second_emoji_id);
const thirdEmoji = document.querySelector(third_emoji_id);
const fourthEmoji = document.querySelector(fourth_emoji_id);
const fifthEmoji = document.querySelector(fifth_emoji_id);
const sixthEmoji = document.querySelector(sixth_emoji_id);
const seventhEmoji = document.querySelector(seventh_emoji_id);

const buttons = document.querySelector(buttons_id);
const buttonMain = document.querySelector(button_main_id);

let isFirstEmojiClick = false;
let isMainButtonClick = false;

firstEmoji.addEventListener('click', onFirstEmojiClick);
buttonMain.addEventListener('click', onMainButtonClick);

function onFirstEmojiClick() {
    isFirstEmojiClick = !isFirstEmojiClick;

    if (isFirstEmojiClick) {
        secondEmoji.classList.add('emoji-visible');
        thirdEmoji.classList.add('emoji-visible');
        fourthEmoji.classList.add('emoji-visible');
        fifthEmoji.classList.add('emoji-visible');
        sixthEmoji.classList.add('emoji-visible');
        seventhEmoji.classList.add('emoji-visible');
        secondEmoji.classList.remove('emoji-hidden');
        thirdEmoji.classList.remove('emoji-hidden');
        fourthEmoji.classList.remove('emoji-hidden');
        fifthEmoji.classList.remove('emoji-hidden');
        sixthEmoji.classList.remove('emoji-hidden');
        seventhEmoji.classList.remove('emoji-hidden');
    } else {
        secondEmoji.classList.remove('emoji-visible');
        thirdEmoji.classList.remove('emoji-visible');
        fourthEmoji.classList.remove('emoji-visible');
        fifthEmoji.classList.remove('emoji-visible');
        sixthEmoji.classList.remove('emoji-visible');
        seventhEmoji.classList.remove('emoji-visible');
        secondEmoji.classList.add('emoji-hidden');
        thirdEmoji.classList.add('emoji-hidden');
        fourthEmoji.classList.add('emoji-hidden');
        fifthEmoji.classList.add('emoji-hidden');
        sixthEmoji.classList.add('emoji-hidden');
        seventhEmoji.classList.add('emoji-hidden');
    }
}

function onMainButtonClick() {
    isMainButtonClick = !isMainButtonClick;

    if (isMainButtonClick) {
        buttons.classList.add('buttons-visible');
        buttons.classList.remove('buttons-hidden');
    } else {
        buttons.classList.remove('buttons-visible');
        buttons.classList.add('buttons-hidden');
    }
}
