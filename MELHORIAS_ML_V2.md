# Coletor ML v2 — brownies CDMX

Esta versão prioriza **qualidade do dado** antes de treinar qualquer modelo.

## O que mudou

1. **Sessão/rota de venda**
   - Ao chegar ao ponto de venda, tocar em **Começar rota de vendas**.
   - O app registra uma amostra inicial e, enquanto a página estiver ativa, tenta coletar nova amostra a cada 5 minutos.
   - Ao voltar para a página depois de deixá-la em segundo plano, o app tenta coletar novamente se já passaram 5 minutos.
   - Ao terminar a saída, tocar em **Encerrar rota** ou encerrar o dia.

2. **Agora o sistema aprende também com “não vendeu”**
   - Cada amostra grava posição, bairro, clima, estoque restante e vendas acumuladas.
   - A view `ml_intervalos_v1` transforma pares de amostras em intervalos e conta quantas vendas realmente ocorreram entre elas.
   - Intervalos com zero vendas passam a existir no dataset — isso é essencial para prever onde NÃO vale a pena ficar.

3. **Vendas idempotentes**
   - `cliente_id` recebe índice UNIQUE.
   - Reenvios offline usam `upsert` em vez de `insert`.
   - A migração remove duplicatas antigas mantendo o registro mais antigo.

4. **Fechamento diário mais seguro**
   - `dia_semana` é calculado a partir da própria data, evitando registros vazios no fechamento automático do dia anterior.
   - Sobras nunca ficam negativas.
   - A migração corrige `dia_semana` e recalcula sobras existentes sem sobrescrever a quantidade histórica de vendas.

5. **Recomendação atual menos enganosa**
   - Continua sendo uma heurística enquanto o ML ainda não tem amostras suficientes.
   - Usa histórico recente, observa estoque esgotado e deixa de escolher bairro apenas pelo número bruto de linhas.
   - O “bairro” mostrado agora é explicitamente um **sinal preliminar**, não uma previsão de ML.

6. **Preparação para ML real**
   - Nova view `ml_intervalos_v1` com uma linha por intervalo de observação.
   - Alvo disponível: `brownies_por_hora_alvo`.
   - Features iniciais: dia da semana, hora, latitude/longitude, grid aproximado, bairro, clima e estoque.

## Passo obrigatório no Supabase

Antes de usar esta versão do app, faça backup do banco e execute no **SQL Editor** o arquivo:

`supabase/migrations/20260920_coleta_ml_v2.sql`

Ele cria:

- colunas `sessao_id` e `vendido_em` em `vendas`;
- tabela `sessoes_venda`;
- tabela `amostras_venda`;
- view `ml_intervalos_v1`;
- view `auditoria_dias_vendas_v1`;
- índice único para impedir duplicação de `cliente_id`.

## Auditoria do histórico atual

Depois da migração, rode:

```sql
select *
from public.auditoria_dias_vendas_v1
where delta_brownies <> 0 or delta_brigadeiros <> 0
order by data desc;
```

Isso mostra dias em que o resumo da tabela `dias` não bate com os eventos individuais da tabela `vendas`.

**Não recomendo corrigir esses dias automaticamente sem revisar**, pois um dos lados pode estar incompleto por causa de falha de internet ou versões antigas do app.

## Como usar no celular

1. Informar quantos brownies/brigadeiros foram levados.
2. Chegar à região onde vai vender.
3. Abrir o app e tocar **Começar rota de vendas**.
4. Registrar cada venda normalmente.
5. Se mudar bastante de ponto e quiser garantir uma amostra, tocar **Coletar agora**.
6. Ao terminar a saída, tocar **Encerrar rota** ou **Encerrar o dia**.

### Importante sobre navegador em segundo plano

Navegadores móveis podem suspender timers quando a tela é bloqueada ou o navegador fica muito tempo em segundo plano. Por isso:

- a coleta de 5 minutos é confiável principalmente enquanto a página está ativa;
- ao voltar para o app, ele tenta registrar uma nova amostra;
- cada venda continua recebendo GPS e horário próprios;
- para coleta contínua real em background, o passo futuro seria um app nativo/Capacitor, não apenas uma página web.

## Quando começar a treinar ML

Não use apenas “número de vendas” como critério. Primeiro acumule diversidade de:

- regiões diferentes;
- dias da semana;
- horários;
- dias bons e ruins;
- intervalos com zero venda;
- estoque disponível.

Como regra prática inicial, eu esperaria pelo menos **200–300 intervalos válidos** na view `ml_intervalos_v1`, distribuídos em várias saídas e regiões, antes de confiar em um modelo mais flexível. Mesmo assim, a validação deve ser cronológica: treinar no passado e testar em dias posteriores.

### Alvo recomendado

Prioridade:

`brownies_por_hora_alvo`

Depois, pode existir um segundo modelo para:

`probabilidade de vender todo o estoque em X horas`

Isso responde melhor à pergunta de negócio do que prever simplesmente “quantos brownies vai vender”.

## Validação técnica feita nesta versão

- `eslint`: passou.
- `tsc --noEmit`: passou.
- `next build`: não pôde ser concluído neste ambiente porque o Next tentou baixar o pacote SWC do npm e a rede externa estava indisponível. O erro ocorreu antes da compilação do projeto e não indica erro TypeScript do código.
