// Прогресс-бар, хедер, кнопка наверх
const progress=document.querySelector('.progress'),
      header=document.querySelector('.header'),
      topBtn=document.querySelector('.top');
addEventListener('scroll',()=>{
  const h=document.documentElement;
  if(progress)progress.style.width=h.scrollTop/(h.scrollHeight-h.clientHeight)*100+'%';
  if(header)header.classList.toggle('scrolled',h.scrollTop>40);
  if(topBtn)topBtn.classList.toggle('show',h.scrollTop>600);
},{passive:true});
if(topBtn)topBtn.addEventListener('click',()=>scrollTo({top:0,behavior:'smooth'}));

// Бургер-меню
const burger=document.querySelector('.burger'),menu=document.querySelector('.menu');
if(burger&&menu){
  burger.addEventListener('click',()=>{burger.classList.toggle('open');menu.classList.toggle('open');});
  menu.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>{burger.classList.remove('open');menu.classList.remove('open');}));
}

// Каскадный вылет блоков при скролле
const io=new IntersectionObserver(es=>es.forEach(e=>{
  if(e.isIntersecting){e.target.classList.add('visible');io.unobserve(e.target);}
}),{threshold:.15});
document.querySelectorAll('.reveal').forEach(el=>io.observe(el));

// ЧаВо-аккордеон с плавным раскрытием
document.querySelectorAll('.faq-q').forEach(btn=>btn.addEventListener('click',()=>{
  const item=btn.closest('.faq-item'),ans=item.querySelector('.faq-a'),open=item.classList.contains('open');
  document.querySelectorAll('.faq-item.open').forEach(i=>{i.classList.remove('open');i.querySelector('.faq-a').style.maxHeight=null;});
  if(!open){item.classList.add('open');ans.style.maxHeight=ans.scrollHeight+'px';}
}));

// Год в футере
const y=document.querySelector('[data-year]');if(y)y.textContent=new Date().getFullYear();