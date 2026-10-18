int counter;

static void bump(void)
{
    counter++;
}

int main(void)
{
    for (;;) {
        bump();
    }
}
