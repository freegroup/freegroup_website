document.addEventListener('DOMContentLoaded', () => {
    const observerOptions = {
        root: null,
        rootMargin: '0px',
        threshold: 0.1
    };

    const observer = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
            }
        });
    }, observerOptions);

    const elements = document.querySelectorAll('.reveal');
    elements.forEach(el => observer.observe(el));

    // Scroll Spy for Navigation
    const navLinks = document.querySelectorAll('nav a');
    const sections = document.querySelectorAll('section');

    function changeLinkState() {
        let index = sections.length;

        while(--index && window.scrollY + 200 < sections[index].offsetTop) {}
        
        navLinks.forEach((link) => link.classList.remove('active'));
        // Safety check if sections exist and index is within bounds
        if (index >= 0 && index < sections.length) {
             // Handle 'Home' being the first section but maybe scrolled to top
             if (window.scrollY < 100) {
                 navLinks[0].classList.add('active');
             } else {
                 navLinks[index].classList.add('active');
             }
        }
    }

    changeLinkState();
    window.addEventListener('scroll', changeLinkState);
});

    
