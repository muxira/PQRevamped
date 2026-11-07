function LoadLanguage(language) {
    try {
        localStorage.setItem('pq_lang', language);
    } catch (e) {
    }
    
    var server = new URLSearchParams(window.location.search).get('server');
    parent.location = 'core/templates/game.html?lang=' + encodeURIComponent(language) +
        (server ? '&server=' + encodeURIComponent(server) : '');
}